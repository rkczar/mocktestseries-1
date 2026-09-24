"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStorageSnapshot } from "@/lib/storage-stats";
import { getGitRepoStatus, getDeploymentStatus, fetchRemoteStatus, type FetchRemoteResult } from "@/lib/git-repo-status";

export async function rescanStorageAction() {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  await getStorageSnapshot({ forceRefresh: true });
  revalidatePath("/admin/system");
}

/** Read-only: re-reads local git state and the production release/pm2 status. Never mutates the repo. */
export async function refreshRepoStatusAction() {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  await Promise.all([
    getGitRepoStatus({ forceRefresh: true }),
    getDeploymentStatus({ forceRefresh: true }),
  ]);
  revalidatePath("/admin/system");
}

/** Read-only: `git fetch` only updates remote-tracking refs, never the working tree or local branch. */
export async function fetchRemoteStatusAction(): Promise<FetchRemoteResult> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await fetchRemoteStatus();
  await getGitRepoStatus({ forceRefresh: true });
  revalidatePath("/admin/system");
  return result;
}
