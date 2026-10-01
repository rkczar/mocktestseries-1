import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  PLATFORM_CONTROLS_KEY,
  PAUSABLE_CONTROLS,
  LOCKDOWN_DURATIONS,
  LOCKDOWN_DURATION_MS,
  MAX_PUBLIC_MESSAGE_LENGTH,
  MAX_REASON_LENGTH,
  bumpPlatformControlsCache,
  parsePlatformControls,
  type LockdownDuration,
  type PausableControl,
  type PlatformControlKey,
  type PlatformControlsState,
} from "@/lib/platform-controls";

/**
 * Writes for Admin → System → Platform Controls. Callers (Server Actions)
 * must already have passed requirePermission(PLATFORM_CONTROLS_MANAGE).
 *
 * Every change runs in one transaction holding a transaction-scoped
 * advisory lock on the document, so two admins saving at once can't
 * overwrite each other, and writes the AuditLog row (control, previous,
 * next, reason, actor) in that same transaction: no change without its
 * audit entry. Only `platform.controls` is written — never payment mode,
 * products, orders, entitlements, attempts or AI data.
 */

export type PlatformControlChange =
  | { control: PausableControl; open: boolean; message?: string; reason?: string }
  | { control: "maintenance"; on: boolean; title?: string; message?: string; eta?: string; reason?: string }
  | { control: "lockdown"; on: boolean; duration?: LockdownDuration; reason?: string };

export class PlatformControlValidationError extends Error {}

/** Plain text only: no control characters or angle brackets, collapsed whitespace, length-capped. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Reasons are free text kept forever in the audit log: refuse things that look like credentials.
const SECRET_PATTERNS = [/rzp_(live|test)_[A-Za-z0-9]{6,}/i, /\bsk-[A-Za-z0-9_-]{16,}/, /\bAIza[0-9A-Za-z_-]{20,}/, /[A-Za-z0-9+/_-]{40,}/, /-----BEGIN [A-Z ]+-----/];
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

/** Changes that must carry a reason: lockdown and maintenance either way, and pausing payments. */
export function reasonRequired(change: PlatformControlChange, current: PlatformControlsState): boolean {
  if (change.control === "lockdown") return change.on !== current.lockdown.on;
  if (change.control === "maintenance") return change.on !== current.maintenance.on;
  if (change.control === "payments") return change.open === false && current.payments.open;
  return false;
}

function snapshot(state: PlatformControlsState, control: PlatformControlKey) {
  const s = { ...(state[control] as unknown as Record<string, unknown>) };
  delete s.updatedAt;
  delete s.updatedBy;
  delete s.updatedByName;
  return s;
}

export async function applyPlatformControlChange(
  change: PlatformControlChange,
  actor: { id: string; name: string | null }
): Promise<PlatformControlsState> {
  if (!PAUSABLE_CONTROLS.includes(change.control as PausableControl) && change.control !== "maintenance" && change.control !== "lockdown") {
    throw new PlatformControlValidationError("Unknown control.");
  }
  const reason = cleanText(change.reason, MAX_REASON_LENGTH);
  if (reason && looksLikeSecret(change.reason ?? "")) {
    throw new PlatformControlValidationError("The reason looks like it contains a key or secret. Describe the issue without credentials.");
  }

  const next = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PLATFORM_CONTROLS_KEY}))`;
    const row = await tx.setting.findUnique({ where: { key: PLATFORM_CONTROLS_KEY } });
    const current = parsePlatformControls(row?.value);
    if (reasonRequired(change, current) && !reason) throw new PlatformControlValidationError("A reason is required for this change.");

    const now = new Date();
    const stamp = { updatedAt: now.toISOString(), updatedBy: actor.id, updatedByName: actor.name };
    const updated: PlatformControlsState = structuredClone(current);

    if (change.control === "maintenance") {
      if (typeof change.on !== "boolean") throw new PlatformControlValidationError("Choose ON or OFF.");
      updated.maintenance = {
        on: change.on,
        title: change.title === undefined ? current.maintenance.title : cleanText(change.title, 120),
        message: change.message === undefined ? current.maintenance.message : cleanText(change.message, MAX_PUBLIC_MESSAGE_LENGTH),
        eta: change.eta === undefined ? current.maintenance.eta : cleanText(change.eta, 120),
        ...stamp,
      };
    } else if (change.control === "lockdown") {
      if (typeof change.on !== "boolean") throw new PlatformControlValidationError("Choose ON or OFF.");
      const duration = change.duration ?? "MANUAL";
      if (!LOCKDOWN_DURATIONS.includes(duration)) throw new PlatformControlValidationError("Unknown lockdown duration.");
      const ms = LOCKDOWN_DURATION_MS[duration];
      updated.lockdown = { on: change.on, until: change.on && ms ? new Date(now.getTime() + ms).toISOString() : null, ...stamp };
    } else {
      if (typeof change.open !== "boolean") throw new PlatformControlValidationError("Choose OPEN or PAUSED.");
      updated[change.control] = {
        open: change.open,
        message: change.message === undefined ? current[change.control].message : cleanText(change.message, MAX_PUBLIC_MESSAGE_LENGTH),
        ...stamp,
      };
    }

    await tx.setting.upsert({
      where: { key: PLATFORM_CONTROLS_KEY },
      update: { value: updated as unknown as Prisma.InputJsonValue },
      create: { key: PLATFORM_CONTROLS_KEY, value: updated as unknown as Prisma.InputJsonValue },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "PLATFORM_CONTROL_CHANGED",
        entityType: "PlatformControl",
        entityId: change.control,
        metadata: {
          control: change.control,
          previous: snapshot(current, change.control),
          next: snapshot(updated, change.control),
          reason: reason || null,
        } as Prisma.InputJsonValue,
      },
    });
    return updated;
  });

  bumpPlatformControlsCache();
  return next;
}
