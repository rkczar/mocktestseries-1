import "server-only";
import { AttemptStatus, DeviceSecurityEventType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStudentDeviceSettings } from "@/lib/student-device-settings";
import { recordDeviceEvent } from "@/lib/student-devices";

/**
 * ONE ACTIVE TEST DEVICE (Security Settings → "One Active Test Session").
 *
 * An in-progress attempt is leased to the device that is running it
 * (TestAttempt.activeDeviceId + activeSeenAt). The run page, every save /
 * reveal / submit and a 60s player heartbeat renew the lease. While another
 * device of the same student holds a fresh lease on ANY of the student's
 * in-progress attempts, a second device can't run a test: the run page
 * renders a notice instead of the questions and engine actions answer
 * OTHER_DEVICE. The first device keeps the attempt.
 *
 * A lease only ever changes the two lease columns — never answers, timer
 * or status — so contention can't corrupt or submit an attempt. A lease
 * that hasn't been renewed for LEASE_MS (device closed, offline, battery
 * died) can be taken over, so a student is never locked out of their own
 * test for longer than that. Revoking a device/session or an admin reset
 * releases its leases (lib/student-devices.ts).
 *
 * Race safety: claims (the slow path) run under the Student row lock, so two
 * devices opening tests at the same moment can't both win. Renewal by the
 * current holder is a single conditional UPDATE.
 *
 * No device context (a pre-device-security session without a device
 * cookie) = not enforced for that request.
 */

export const LEASE_MS = 3 * 60 * 1000;
const CONFLICT_EVENT_THROTTLE_MS = 60 * 60 * 1000;

export const OTHER_DEVICE_MESSAGE =
  "This test is open on another device. Continue it there, or close it on that device and wait a few minutes before continuing here.";

export type LeaseResult = { ok: true } | { ok: false; reason: "OTHER_DEVICE" };

async function recordConflict(studentId: string, attemptId: string, deviceId: string, holderDeviceId: string | null) {
  const since = new Date(Date.now() - CONFLICT_EVENT_THROTTLE_MS);
  const recent = await prisma.deviceSecurityEvent.count({
    where: { studentId, eventType: DeviceSecurityEventType.TEST_DEVICE_CONFLICT, createdAt: { gte: since } },
  });
  if (recent > 0) return;
  await recordDeviceEvent(prisma, {
    studentId,
    deviceId,
    eventType: DeviceSecurityEventType.TEST_DEVICE_CONFLICT,
    metadata: { attemptId, holderDeviceId },
  });
  await recordDeviceEvent(prisma, {
    studentId,
    deviceId,
    eventType: DeviceSecurityEventType.SUSPICIOUS_DEVICE_ACTIVITY,
    metadata: { reason: "SIMULTANEOUS_TEST_DEVICES", attemptId },
  });
}

/**
 * Claim or renew the lease on an attempt for `deviceId`. Returns ok when the
 * feature is off, there's no device context, or the attempt isn't in
 * progress (the engine reports those states itself).
 */
export async function claimAttemptLease(attemptId: string, studentId: string, deviceId: string | null | undefined): Promise<LeaseResult> {
  if (!deviceId) return { ok: true };
  const settings = await getStudentDeviceSettings();
  if (!settings.oneActiveTestDevice) return { ok: true };

  const now = new Date();
  const freshAfter = new Date(now.getTime() - LEASE_MS);

  // Fast path: this device already holds a fresh lease.
  const renewed = await prisma.testAttempt.updateMany({
    where: { id: attemptId, studentId, status: AttemptStatus.IN_PROGRESS, activeDeviceId: deviceId, activeSeenAt: { gt: freshAfter } },
    data: { activeSeenAt: now },
  });
  if (renewed.count === 1) return { ok: true };

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
    const attempt = await tx.testAttempt.findFirst({ where: { id: attemptId, studentId }, select: { status: true } });
    if (!attempt || attempt.status !== AttemptStatus.IN_PROGRESS) return { ok: true as const };
    const holder = await tx.testAttempt.findFirst({
      where: {
        studentId,
        status: AttemptStatus.IN_PROGRESS,
        activeDeviceId: { not: null },
        NOT: { activeDeviceId: deviceId },
        activeSeenAt: { gt: freshAfter },
      },
      select: { activeDeviceId: true },
    });
    if (holder) return { ok: false as const, holderDeviceId: holder.activeDeviceId };
    await tx.testAttempt.update({ where: { id: attemptId }, data: { activeDeviceId: deviceId, activeSeenAt: now } });
    return { ok: true as const };
  });

  if (outcome.ok) return { ok: true };
  await recordConflict(studentId, attemptId, deviceId, outcome.holderDeviceId).catch(() => {});
  return { ok: false, reason: "OTHER_DEVICE" };
}
