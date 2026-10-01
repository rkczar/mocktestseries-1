"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PAUSABLE_CONTROLS, LOCKDOWN_DURATIONS, type LockdownDuration, type PausableControl } from "@/lib/platform-controls";
import { applyPlatformControlChange, PlatformControlValidationError, type PlatformControlChange } from "@/lib/platform-controls-admin";

export interface PlatformControlFormState {
  error?: string;
  success?: string;
}

const LABELS: Record<string, string> = {
  registrations: "New Registrations",
  login: "Student Login",
  payments: "New Payments",
  tests: "Start New Tests",
  ai: "AI Services",
  maintenance: "Maintenance Mode",
  lockdown: "Emergency Lockdown",
};

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const opt = (fd: FormData, k: string) => (fd.has(k) ? str(fd, k) : undefined);

/**
 * The single mutation for Admin → System → Platform Controls.
 * MASTER_ADMIN only (PLATFORM_CONTROLS_MANAGE); FULL_ADMIN holds only the
 * VIEW key and is refused here even if the disabled form is replayed.
 * Validation, the advisory lock and the AuditLog row live in
 * applyPlatformControlChange.
 */
export async function setPlatformControlAction(_prev: PlatformControlFormState, fd: FormData): Promise<PlatformControlFormState> {
  try {
    const session = await requirePermission(PERMISSIONS.PLATFORM_CONTROLS_MANAGE);
    const control = str(fd, "control");
    const value = str(fd, "value");
    const reason = opt(fd, "reason");
    let change: PlatformControlChange;

    if (PAUSABLE_CONTROLS.includes(control as PausableControl)) {
      if (value !== "OPEN" && value !== "PAUSED") return { error: "Choose OPEN or PAUSED." };
      change = { control: control as PausableControl, open: value === "OPEN", message: opt(fd, "message"), reason };
    } else if (control === "maintenance") {
      if (value !== "ON" && value !== "OFF") return { error: "Choose ON or OFF." };
      change = { control, on: value === "ON", title: opt(fd, "title"), message: opt(fd, "message"), eta: opt(fd, "eta"), reason };
    } else if (control === "lockdown") {
      if (value !== "ON" && value !== "OFF") return { error: "Choose ON or OFF." };
      const duration = (str(fd, "duration") || "MANUAL") as LockdownDuration;
      if (!LOCKDOWN_DURATIONS.includes(duration)) return { error: "Unknown lockdown duration." };
      if (value === "ON" && str(fd, "confirm").trim() !== "LOCKDOWN") return { error: "Type LOCKDOWN to confirm." };
      change = { control, on: value === "ON", duration, reason };
    } else {
      return { error: "Unknown control." };
    }

    if (!session.user.id) throw new UnauthorizedError("Not signed in");
    await applyPlatformControlChange(change, { id: session.user.id, name: session.user.name ?? null });
    revalidatePath("/admin/system/platform-controls");
    revalidatePath("/admin");
    return { success: `${LABELS[control]} is now ${value}.` };
  } catch (e) {
    if (e instanceof UnauthorizedError) return { error: "Forbidden — only Master Admin can change Platform Controls." };
    if (e instanceof PlatformControlValidationError) return { error: e.message };
    console.error("[platform-controls] change failed", e);
    return { error: "Something went wrong. Nothing was changed." };
  }
}
