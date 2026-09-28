import "server-only";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { DeviceSecurityEventType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clientIpFromHeaders, UNKNOWN_IP } from "@/lib/client-ip";
import { describeUserAgent } from "@/lib/device-info";
import {
  DEVICE_COOKIE_NAME,
  deviceCookieOptions,
  hashDeviceId,
  hashToken,
  mintDeviceCookieValue,
  randomToken,
  verifyDeviceCookieValue,
} from "@/lib/device-cookie";
import { getStudentDeviceSettings, type StudentDeviceSettings } from "@/lib/student-device-settings";
import { isStudentAuthEligible } from "@/lib/student-lifecycle";

/**
 * STUDENT DEVICE LIMIT + SESSION MANAGEMENT.
 *
 * Enforcement point: every successful student sign-in (password, OTP,
 * create-account, Google) calls admitStudentSignIn() BEFORE Auth.js issues
 * the session cookie — from the Credentials authorize() functions and the
 * Google signIn callback in lib/auth-student.ts. A blocked device never
 * receives a student session.
 *
 * Race safety: admission runs in one transaction that first takes a row
 * lock on the Student (SELECT … FOR UPDATE), so concurrent sign-ins for one
 * student — from any PM2 worker — are serialized by Postgres and can never
 * both take the last slot. The (studentId, deviceHash) unique index stops a
 * device from ever being registered twice.
 *
 * Revocation: the JWT carries a random session secret (only its SHA-256 is
 * stored, StudentSession.tokenHash) and the device row id. The Node-runtime
 * jwt callback calls checkStudentToken() on every auth() call; a revoked or
 * expired session, a revoked device, or a "log out all" (sessionsValidAfter)
 * signs the request out, so pages, Server Actions, route handlers and test
 * APIs all stop together. Admin sessions use a separate Auth.js instance
 * and are never touched.
 *
 * Existing users: tokens issued before this feature (no session secret)
 * stay valid. Their device is registered on first use if a slot is free
 * (registeredVia LEGACY_SESSION), never blocked; they are still subject to
 * device revocation (by cookie) and "log out all".
 */

export const DEVICE_LIMIT_TITLE = "Device Limit Reached";
export const DEVICE_LIMIT_MESSAGE =
  "Device Limit Reached\n\nYour account is already registered on the maximum number of devices. For account security, you cannot sign in on this device.\n\nPlease remove an existing device or contact support.";

/** Mirrors the JWT lifetime (Auth.js default 30 days, rolling). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** lastSeenAt writes are throttled to one per this interval per session/device. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SUSPICIOUS_BLOCKS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SUSPICIOUS_WINDOW_MS = 7 * DAY_MS;
export const LIMIT_REACHED_WINDOW_MS = 30 * DAY_MS;

export class DeviceLimitError extends Error {
  constructor() {
    super(DEVICE_LIMIT_MESSAGE);
    this.name = "DeviceLimitError";
  }
}

export class DeviceActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceActionError";
  }
}

// ---------------------------------------------------------------------------
// Request signals (IP / UA are supporting metadata only — never identity)
// ---------------------------------------------------------------------------

export interface RequestSignals {
  userAgent: string | null;
  ip: string | null;
}

function ipKey(): string {
  return process.env.DEVICE_ID_SECRET || process.env.AUTH_SECRET || "";
}

export function hashIp(ip: string | null): string | null {
  if (!ip || ip === UNKNOWN_IP) return null;
  return createHash("sha256").update(`ip:${ipKey()}:${ip}`).digest("hex");
}

/** "103.21.44.7" -> "103.21.x.x"; "2401:4900:1c2a::1" -> "2401:4900:x:x". Admin display only. */
export function maskIp(ip: string | null): string | null {
  if (!ip || ip === UNKNOWN_IP) return null;
  if (ip.includes(".")) {
    const p = ip.split(".");
    return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : null;
  }
  const groups = ip.split(":").filter(Boolean);
  return groups.length >= 2 ? `${groups[0]}:${groups[1]}:x:x` : null;
}

export async function currentRequestSignals(): Promise<RequestSignals> {
  try {
    const h = await headers();
    return { userAgent: h.get("user-agent"), ip: clientIpFromHeaders(h) };
  } catch {
    return { userAgent: null, ip: null };
  }
}

/** The verified device id from this request's `mts-device` cookie, or null. */
export async function readDeviceIdFromRequest(): Promise<string | null> {
  try {
    const store = await cookies();
    return await verifyDeviceCookieValue(store.get(DEVICE_COOKIE_NAME)?.value);
  } catch {
    return null;
  }
}

/**
 * Device id for a sign-in. Middleware normally guarantees the cookie exists
 * (see middleware.ts); if it somehow doesn't, mint one here and set it on
 * the sign-in response (Server Actions and route handlers may write cookies).
 */
export async function deviceIdForSignIn(): Promise<string> {
  const existing = await readDeviceIdFromRequest();
  if (existing) return existing;
  const value = await mintDeviceCookieValue();
  try {
    (await cookies()).set(DEVICE_COOKIE_NAME, value, deviceCookieOptions);
  } catch {
    // Not writable in this context; the device is still identified for this sign-in.
  }
  return (await verifyDeviceCookieValue(value))!;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

export async function recordDeviceEvent(
  db: Db,
  data: {
    studentId: string | null;
    eventType: DeviceSecurityEventType;
    deviceId?: string | null;
    sessionId?: string | null;
    actorAdminId?: string | null;
    metadata?: Prisma.InputJsonObject;
  }
) {
  await db.deviceSecurityEvent.create({
    data: {
      studentId: data.studentId,
      eventType: data.eventType,
      deviceId: data.deviceId ?? null,
      sessionId: data.sessionId ?? null,
      actorAdminId: data.actorAdminId ?? null,
      metadata: data.metadata,
    },
  });
}

/** Flags an account once per day after repeated device-limit blocks. */
async function maybeFlagRepeatedBlocks(studentId: string) {
  const since = new Date(Date.now() - DAY_MS);
  const [blocks, alreadyFlagged] = await Promise.all([
    prisma.deviceSecurityEvent.count({
      where: { studentId, eventType: DeviceSecurityEventType.DEVICE_LIMIT_REACHED, createdAt: { gte: since } },
    }),
    prisma.deviceSecurityEvent.count({
      where: { studentId, eventType: DeviceSecurityEventType.SUSPICIOUS_DEVICE_ACTIVITY, createdAt: { gte: since } },
    }),
  ]);
  if (blocks >= SUSPICIOUS_BLOCKS_PER_DAY && alreadyFlagged === 0) {
    await recordDeviceEvent(prisma, {
      studentId,
      eventType: DeviceSecurityEventType.SUSPICIOUS_DEVICE_ACTIVITY,
      metadata: { reason: "REPEATED_DEVICE_LIMIT_BLOCKS", blocksLast24h: blocks },
    });
  }
}

// ---------------------------------------------------------------------------
// Sign-in admission
// ---------------------------------------------------------------------------

export interface AdmittedSignIn {
  deviceId: string;
  /** Raw session secret for the JWT (only its hash is stored). Null when session tracking is off. */
  sessionSecret: string | null;
  sessionRowId: string | null;
  authAt: number;
  newlyRegistered: boolean;
}

export type SignInMethod = "PASSWORD" | "OTP" | "CREATE_ACCOUNT" | "GOOGLE" | "LEGACY_SESSION";

type AdmitResult =
  | { blocked: true; activeCount: number; limit: number }
  | ({ blocked: false } & AdmittedSignIn);

async function lockStudent(tx: Prisma.TransactionClient, studentId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
}

/**
 * Core admission, concurrency-safe. `legacy` = lazily registering the device
 * of a pre-existing token: never blocks and never creates a session.
 */
async function admitDevice(
  studentId: string,
  deviceIdRaw: string,
  method: SignInMethod,
  signals: RequestSignals,
  settings: StudentDeviceSettings,
  opts: { legacy?: boolean } = {}
): Promise<AdmitResult | { blocked: false; skipped: true }> {
  const deviceHash = await hashDeviceId(deviceIdRaw);
  const info = describeUserAgent(signals.userAgent);
  const now = new Date();
  const meta = {
    displayName: info.displayName,
    deviceType: info.deviceType,
    browser: info.browser,
    os: info.os,
    userAgent: signals.userAgent?.slice(0, 512) ?? null,
    lastIpHash: hashIp(signals.ip),
    lastIpMasked: maskIp(signals.ip),
    lastSeenAt: now,
  };

  return prisma.$transaction(async (tx) => {
    await lockStudent(tx, studentId);
    const existing = await tx.studentDevice.findUnique({
      where: { studentId_deviceHash: { studentId, deviceHash } },
    });

    let deviceId: string;
    let newlyRegistered = false;
    if (existing?.active) {
      deviceId = existing.id;
      await tx.studentDevice.update({
        where: { id: existing.id },
        data: opts.legacy ? { lastSeenAt: now } : { ...meta, lastLoginAt: now },
      });
    } else {
      if (opts.legacy && existing && !existing.active) return { blocked: false as const, skipped: true as const };
      const activeCount = await tx.studentDevice.count({ where: { studentId, active: true } });
      const overLimit = settings.enabled && activeCount >= settings.maxDevices;
      if (overLimit && (opts.legacy || settings.blockNewDevice)) {
        if (opts.legacy) return { blocked: false as const, skipped: true as const };
        return { blocked: true as const, activeCount, limit: settings.maxDevices };
      }
      const data = {
        ...meta,
        lastLoginAt: opts.legacy ? null : now,
        active: true,
        revokedAt: null,
        revokedByAdminId: null,
        revokeReason: null,
        registeredVia: opts.legacy ? "LEGACY_SESSION" : "LOGIN",
      };
      const device = existing
        ? await tx.studentDevice.update({ where: { id: existing.id }, data: { ...data, firstSeenAt: now } })
        : await tx.studentDevice.create({ data: { ...data, studentId, deviceHash } });
      deviceId = device.id;
      newlyRegistered = true;
      await recordDeviceEvent(tx, {
        studentId,
        deviceId,
        eventType: DeviceSecurityEventType.DEVICE_REGISTERED,
        metadata: {
          method,
          device: info.displayName,
          slot: activeCount + 1,
          limit: settings.maxDevices,
          ...(overLimit ? { overLimit: true } : {}),
          ...(existing ? { reRegistered: true } : {}),
        },
      });
    }

    if (opts.legacy) {
      return { blocked: false as const, deviceId, sessionSecret: null, sessionRowId: null, authAt: now.getTime(), newlyRegistered };
    }

    let sessionSecret: string | null = null;
    let sessionRowId: string | null = null;
    if (settings.trackSessions) {
      // One live session per device: a fresh sign-in on the same browser replaces the old cookie.
      await tx.studentSession.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: now, revokeReason: "REPLACED" },
      });
      sessionSecret = randomToken();
      const session = await tx.studentSession.create({
        data: {
          studentId,
          deviceId,
          tokenHash: await hashToken(sessionSecret),
          method,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        },
      });
      sessionRowId = session.id;
    }
    await recordDeviceEvent(tx, {
      studentId,
      deviceId,
      sessionId: sessionRowId,
      eventType: DeviceSecurityEventType.LOGIN_SUCCESS,
      metadata: { method, device: info.displayName },
    });
    return { blocked: false as const, deviceId, sessionSecret, sessionRowId, authAt: now.getTime(), newlyRegistered };
  });
}

/**
 * Admit a sign-in that has already passed credential/OTP/Google checks.
 * Throws DeviceLimitError (after recording the block) when the device is new
 * and the student already holds the maximum number of devices.
 */
export async function admitStudentSignIn(
  studentId: string,
  method: SignInMethod,
  input: { deviceIdRaw: string; signals: RequestSignals; identifier?: string }
): Promise<AdmittedSignIn> {
  const settings = await getStudentDeviceSettings();
  const result = await admitDevice(studentId, input.deviceIdRaw, method, input.signals, settings);
  if ("skipped" in result) throw new Error("unreachable: sign-in admission skipped");
  if (result.blocked) {
    const info = describeUserAgent(input.signals.userAgent);
    await recordDeviceEvent(prisma, {
      studentId,
      eventType: DeviceSecurityEventType.DEVICE_LIMIT_REACHED,
      metadata: {
        method,
        device: info.displayName,
        activeDevices: result.activeCount,
        limit: result.limit,
        ipMasked: maskIp(input.signals.ip),
      },
    });
    await prisma.studentLoginAttempt.create({
      data: {
        identifier: input.identifier ?? "unknown",
        ipAddress: input.signals.ip ?? UNKNOWN_IP,
        success: false,
        method: "DEVICE_LIMIT",
        studentId,
      },
    });
    await maybeFlagRepeatedBlocks(studentId);
    throw new DeviceLimitError();
  }
  return result;
}

/** admitStudentSignIn() using this request's device cookie, UA and IP. */
export async function admitCurrentRequestSignIn(studentId: string, method: SignInMethod, identifier?: string) {
  const [deviceIdRaw, signals] = await Promise.all([deviceIdForSignIn(), currentRequestSignals()]);
  return admitStudentSignIn(studentId, method, { deviceIdRaw, signals, identifier });
}

// ---------------------------------------------------------------------------
// Per-request session check (jwt callback)
// ---------------------------------------------------------------------------

export interface StudentTokenClaims {
  studentDbId?: string;
  /** Raw session secret. */
  sid?: string;
  /** StudentSession row id. */
  sref?: string;
  /** StudentDevice row id. */
  did?: string;
  /** Sign-in time (ms). */
  authAt?: number;
  iat?: number;
}

export type TokenCheck =
  | { ok: false; reason: string }
  | { ok: true; deviceId: string | null; sessionRowId: string | null };

function stale(lastSeenAt: Date, now: number) {
  return now - lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
}

/**
 * Is this student JWT still allowed? One indexed lookup per check, plus a
 * throttled lastSeenAt write at most every 5 minutes.
 */
export async function checkStudentToken(
  claims: StudentTokenClaims,
  resolveLegacyDevice: () => Promise<string | null> = readDeviceIdFromRequest,
  signals?: () => Promise<RequestSignals>
): Promise<TokenCheck> {
  const studentId = claims.studentDbId;
  if (!studentId) return { ok: false, reason: "NO_STUDENT" };
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { status: true, sessionsValidAfter: true },
  });
  if (!student || !isStudentAuthEligible(student.status)) return { ok: false, reason: "ACCOUNT" };
  const now = Date.now();

  if (claims.sid) {
    const session = await prisma.studentSession.findUnique({
      where: { tokenHash: await hashToken(claims.sid) },
      select: {
        id: true,
        studentId: true,
        revokedAt: true,
        expiresAt: true,
        lastSeenAt: true,
        deviceId: true,
        device: { select: { active: true, lastSeenAt: true } },
      },
    });
    if (!session || session.studentId !== studentId) return { ok: false, reason: "SESSION_UNKNOWN" };
    if (session.revokedAt) return { ok: false, reason: "SESSION_REVOKED" };
    if (session.expiresAt.getTime() < now) return { ok: false, reason: "SESSION_EXPIRED" };
    if (!session.device.active) return { ok: false, reason: "DEVICE_REVOKED" };
    if (stale(session.lastSeenAt, now)) {
      const at = new Date(now);
      await Promise.all([
        prisma.studentSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { lastSeenAt: at, expiresAt: new Date(now + SESSION_TTL_MS) },
        }),
        prisma.studentDevice.updateMany({ where: { id: session.deviceId, active: true }, data: { lastSeenAt: at } }),
      ]).catch(() => {});
    }
    return { ok: true, deviceId: session.deviceId, sessionRowId: session.id };
  }

  // No tracked session: a token from before device security, or session tracking off.
  const authAt = claims.authAt ?? (claims.iat ? claims.iat * 1000 : 0);
  if (student.sessionsValidAfter && authAt < student.sessionsValidAfter.getTime()) {
    return { ok: false, reason: "LOGGED_OUT_ALL" };
  }

  if (claims.did) {
    const device = await prisma.studentDevice.findUnique({
      where: { id: claims.did },
      select: { studentId: true, active: true, lastSeenAt: true },
    });
    if (!device || device.studentId !== studentId || !device.active) return { ok: false, reason: "DEVICE_REVOKED" };
    if (stale(device.lastSeenAt, now)) {
      await prisma.studentDevice.updateMany({ where: { id: claims.did, active: true }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
    }
    return { ok: true, deviceId: claims.did, sessionRowId: null };
  }

  // Legacy token: identify the browser by its device cookie.
  const raw = await resolveLegacyDevice();
  if (!raw) return { ok: true, deviceId: null, sessionRowId: null };
  const deviceHash = await hashDeviceId(raw);
  const device = await prisma.studentDevice.findUnique({
    where: { studentId_deviceHash: { studentId, deviceHash } },
    select: { id: true, active: true, revokedAt: true, lastSeenAt: true },
  });
  if (device) {
    if (!device.active && device.revokedAt) return { ok: false, reason: "DEVICE_REVOKED" };
    if (device.active && stale(device.lastSeenAt, now)) {
      await prisma.studentDevice.updateMany({ where: { id: device.id, active: true }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
    }
    return { ok: true, deviceId: device.active ? device.id : null, sessionRowId: null };
  }
  try {
    const settings = await getStudentDeviceSettings();
    const result = await admitDevice(studentId, raw, "LEGACY_SESSION", await (signals ?? currentRequestSignals)(), settings, {
      legacy: true,
    });
    return { ok: true, deviceId: "deviceId" in result ? result.deviceId : null, sessionRowId: null };
  } catch {
    // Registration is best-effort for legacy tokens; never sign an existing student out over it.
    return { ok: true, deviceId: null, sessionRowId: null };
  }
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type DeviceActor = { adminId: string } | { studentId: string } | { system: string };

function actorMeta(actor: DeviceActor): { actorAdminId: string | null; by: string } {
  if ("adminId" in actor) return { actorAdminId: actor.adminId, by: "ADMIN" };
  if ("studentId" in actor) return { actorAdminId: null, by: "STUDENT" };
  return { actorAdminId: null, by: actor.system };
}

/** Frees a device's claim on in-progress tests (lease only — answers are untouched). */
async function releaseAttemptLeases(db: Db, where: Prisma.TestAttemptWhereInput) {
  await db.testAttempt.updateMany({ where, data: { activeDeviceId: null, activeSeenAt: null } });
}

/** Log out one session. The device keeps its slot. */
export async function revokeStudentSession(studentId: string, sessionRowId: string, actor: DeviceActor, reason = "LOGOUT") {
  const { actorAdminId, by } = actorMeta(actor);
  return prisma.$transaction(async (tx) => {
    const session = await tx.studentSession.findFirst({ where: { id: sessionRowId, studentId } });
    if (!session) throw new DeviceActionError("Session not found.");
    if (session.revokedAt) return { changed: false };
    await tx.studentSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokeReason: reason, revokedByAdminId: actorAdminId },
    });
    const stillOpen = await tx.studentSession.count({ where: { deviceId: session.deviceId, revokedAt: null } });
    if (stillOpen === 0) await releaseAttemptLeases(tx, { activeDeviceId: session.deviceId });
    await recordDeviceEvent(tx, {
      studentId,
      deviceId: session.deviceId,
      sessionId: session.id,
      actorAdminId,
      eventType: DeviceSecurityEventType.SESSION_REVOKED,
      metadata: { by, reason },
    });
    return { changed: true };
  });
}

/** Sign-out of the current session (Auth.js signOut event). Best-effort. */
export async function revokeSessionBySecret(sessionSecret: string, reason = "LOGOUT") {
  const session = await prisma.studentSession.findUnique({ where: { tokenHash: await hashToken(sessionSecret) } });
  if (!session || session.revokedAt) return;
  await revokeStudentSession(session.studentId, session.id, { studentId: session.studentId }, reason);
}

/** Revoke a device: frees its slot and signs out every session on it. */
export async function revokeStudentDevice(
  studentId: string,
  deviceId: string,
  actor: DeviceActor,
  reason = "REVOKED",
  /** Runs after the student row lock is held (e.g. a rate-limit check). */
  guard?: (tx: Prisma.TransactionClient) => Promise<void>
) {
  const { actorAdminId, by } = actorMeta(actor);
  return prisma.$transaction(async (tx) => {
    await lockStudent(tx, studentId);
    if (guard) await guard(tx);
    const device = await tx.studentDevice.findFirst({ where: { id: deviceId, studentId } });
    if (!device) throw new DeviceActionError("Device not found.");
    if (!device.active) return { changed: false };
    const now = new Date();
    await tx.studentDevice.update({
      where: { id: device.id },
      data: { active: false, revokedAt: now, revokedByAdminId: actorAdminId, revokeReason: reason },
    });
    const sessions = await tx.studentSession.updateMany({
      where: { deviceId: device.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: `DEVICE_${reason}`, revokedByAdminId: actorAdminId },
    });
    await releaseAttemptLeases(tx, { activeDeviceId: device.id });
    await recordDeviceEvent(tx, {
      studentId,
      deviceId: device.id,
      actorAdminId,
      eventType: DeviceSecurityEventType.DEVICE_REMOVED,
      metadata: { by, reason, device: device.displayName, sessionsRevoked: sessions.count },
    });
    return { changed: true };
  });
}

/**
 * Log out every session of a student (optionally keeping one, e.g. the
 * session that just changed the password). Registered devices keep their
 * slots. Also invalidates untracked/legacy tokens via sessionsValidAfter.
 */
export async function logoutAllStudentSessions(
  studentId: string,
  actor: DeviceActor,
  opts: { exceptSessionRowId?: string | null; reason?: string; cutoffUntracked?: boolean } = {}
) {
  const { actorAdminId, by } = actorMeta(actor);
  const reason = opts.reason ?? "LOGOUT_ALL";
  return prisma.$transaction(async (tx) => {
    await lockStudent(tx, studentId);
    const now = new Date();
    const keep = opts.exceptSessionRowId ?? null;
    const kept = keep ? await tx.studentSession.findFirst({ where: { id: keep, studentId }, select: { deviceId: true } }) : null;
    const sessions = await tx.studentSession.updateMany({
      where: { studentId, revokedAt: null, ...(keep ? { id: { not: keep } } : {}) },
      data: { revokedAt: now, revokeReason: reason, revokedByAdminId: actorAdminId },
    });
    // The cut-off also ends untracked (pre-device-security) tokens; the caller's
    // own untracked session would end with them, so it can opt out.
    if (opts.cutoffUntracked !== false) await tx.student.update({ where: { id: studentId }, data: { sessionsValidAfter: now } });
    await releaseAttemptLeases(tx, {
      studentId,
      ...(kept ? { OR: [{ activeDeviceId: null }, { activeDeviceId: { not: kept.deviceId } }] } : {}),
    });
    await recordDeviceEvent(tx, {
      studentId,
      actorAdminId,
      eventType: DeviceSecurityEventType.LOGOUT_ALL,
      metadata: { by, reason, sessionsRevoked: sessions.count, keptCurrentSession: Boolean(keep) },
    });
    return { sessionsRevoked: sessions.count };
  });
}

/**
 * Admin "Reset Device Limit": revokes every registered device and session,
 * clears the consumed slots so the student can register new devices
 * immediately, and records who did it. History is never deleted — devices
 * are marked revoked, not removed, and every event row is kept.
 */
export async function resetStudentDeviceLimit(studentId: string, adminId: string) {
  const settings = await getStudentDeviceSettings();
  if (!settings.allowAdminReset) throw new DeviceActionError("Admin device reset is disabled in Security Settings.");
  return prisma.$transaction(async (tx) => {
    await lockStudent(tx, studentId);
    const now = new Date();
    const devices = await tx.studentDevice.updateMany({
      where: { studentId, active: true },
      data: { active: false, revokedAt: now, revokedByAdminId: adminId, revokeReason: "ADMIN_RESET" },
    });
    const sessions = await tx.studentSession.updateMany({
      where: { studentId, revokedAt: null },
      data: { revokedAt: now, revokeReason: "ADMIN_RESET", revokedByAdminId: adminId },
    });
    await tx.student.update({ where: { id: studentId }, data: { sessionsValidAfter: now, deviceLimitResetAt: now } });
    await releaseAttemptLeases(tx, { studentId });
    await recordDeviceEvent(tx, {
      studentId,
      actorAdminId: adminId,
      eventType: DeviceSecurityEventType.ADMIN_DEVICE_RESET,
      metadata: { devicesRevoked: devices.count, sessionsRevoked: sessions.count, at: now.toISOString() },
    });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "STUDENT_DEVICE_LIMIT_RESET",
        entityType: "Student",
        entityId: studentId,
        metadata: { devicesRevoked: devices.count, sessionsRevoked: sessions.count },
      },
    });
    return { devicesRevoked: devices.count, sessionsRevoked: sessions.count };
  });
}

/**
 * Student removes one of their own devices (frees a slot). Only when the
 * admin setting allows it, never the current device, and at most once per
 * cooldown window so slot-swapping can't be used to share an account.
 */
export async function studentRemoveOwnDevice(studentId: string, deviceId: string, currentDeviceId: string | null) {
  const settings = await getStudentDeviceSettings();
  if (!settings.studentSelfRemove) throw new DeviceActionError("Removing devices yourself is not enabled. Please contact support.");
  if (currentDeviceId && deviceId === currentDeviceId) {
    throw new DeviceActionError("You can't remove the device you are using. Use Logout instead.");
  }
  // Checked under the student row lock, so two parallel removals can't both pass.
  return revokeStudentDevice(studentId, deviceId, { studentId }, "STUDENT_REMOVED", async (tx) => {
    const next = await nextSelfRemovalAt(studentId, settings, tx);
    if (next && next.getTime() > Date.now()) {
      throw new DeviceActionError(`You can remove another device after ${next.toLocaleDateString("en-IN")}.`);
    }
  });
}

async function nextSelfRemovalAt(studentId: string, settings: StudentDeviceSettings, db: Db = prisma): Promise<Date | null> {
  const last = await db.deviceSecurityEvent.findFirst({
    where: { studentId, eventType: DeviceSecurityEventType.DEVICE_REMOVED, metadata: { path: ["by"], equals: "STUDENT" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return last ? new Date(last.createdAt.getTime() + settings.selfRemoveCooldownDays * DAY_MS) : null;
}

// ---------------------------------------------------------------------------
// Read models for Student Profile / Admin pages
// ---------------------------------------------------------------------------

export type DeviceSecurityStatus = "NORMAL" | "LIMIT_REACHED" | "SUSPICIOUS";

export function deriveSecurityStatus(input: {
  lastSuspiciousAt: Date | null;
  lastBlockAt: Date | null;
  resetAt: Date | null;
  now?: number;
}): DeviceSecurityStatus {
  const now = input.now ?? Date.now();
  const after = (d: Date | null, windowMs: number) =>
    !!d && now - d.getTime() < windowMs && (!input.resetAt || d > input.resetAt);
  if (after(input.lastSuspiciousAt, SUSPICIOUS_WINDOW_MS)) return "SUSPICIOUS";
  if (after(input.lastBlockAt, LIMIT_REACHED_WINDOW_MS)) return "LIMIT_REACHED";
  return "NORMAL";
}

function futureOrNull(date: Date | null, now: Date): Date | null {
  return date && date > now ? date : null;
}

export async function getStudentDeviceOverview(studentId: string) {
  const now = new Date();
  const [settings, student, devices, lastBlock, lastSuspicious, events, leases] = await Promise.all([
    getStudentDeviceSettings(),
    prisma.student.findUnique({ where: { id: studentId }, select: { deviceLimitResetAt: true, lastLoginAt: true } }),
    prisma.studentDevice.findMany({
      where: { studentId },
      orderBy: [{ active: "desc" }, { lastSeenAt: "desc" }],
      include: {
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          orderBy: { lastSeenAt: "desc" },
          select: { id: true, method: true, createdAt: true, lastSeenAt: true },
        },
        revokedByAdmin: { select: { name: true } },
      },
    }),
    prisma.deviceSecurityEvent.findFirst({
      where: { studentId, eventType: DeviceSecurityEventType.DEVICE_LIMIT_REACHED },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.deviceSecurityEvent.findFirst({
      where: { studentId, eventType: DeviceSecurityEventType.SUSPICIOUS_DEVICE_ACTIVITY },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.deviceSecurityEvent.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { actorAdmin: { select: { name: true } }, device: { select: { displayName: true } } },
    }),
    prisma.testAttempt.findMany({
      where: { studentId, status: "IN_PROGRESS", activeDeviceId: { not: null } },
      select: { activeDeviceId: true, activeSeenAt: true },
    }),
  ]);
  const registered = devices.filter((d) => d.active).length;
  const activeSessions = devices.reduce((n, d) => n + (d.active ? d.sessions.length : 0), 0);
  const testDeviceIds = new Set(leases.map((l) => l.activeDeviceId as string));
  return {
    settings,
    limit: settings.maxDevices,
    registered,
    activeSessions,
    lastLoginAt: student?.lastLoginAt ?? null,
    resetAt: student?.deviceLimitResetAt ?? null,
    status: deriveSecurityStatus({
      lastSuspiciousAt: lastSuspicious?.createdAt ?? null,
      lastBlockAt: lastBlock?.createdAt ?? null,
      resetAt: student?.deviceLimitResetAt ?? null,
    }),
    devices: devices.map((d) => ({ ...d, hasTestInProgress: testDeviceIds.has(d.id) })),
    events,
    /** When the student may next remove a device themselves; null = now (or self-removal is off). */
    nextSelfRemovalAt: settings.studentSelfRemove ? futureOrNull(await nextSelfRemovalAt(studentId, settings), now) : null,
  };
}

export async function getDeviceMonitoringData(limit = 500) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const settings = await getStudentDeviceSettings();
  const [activeSessions, registeredDevices, blocksToday, resetsToday, suspiciousRows, blockRows, students] = await Promise.all([
    prisma.studentSession.count({ where: { revokedAt: null, expiresAt: { gt: now }, device: { active: true } } }),
    prisma.studentDevice.count({ where: { active: true } }),
    prisma.deviceSecurityEvent.count({ where: { eventType: DeviceSecurityEventType.DEVICE_LIMIT_REACHED, createdAt: { gte: startOfDay } } }),
    prisma.deviceSecurityEvent.count({ where: { eventType: DeviceSecurityEventType.ADMIN_DEVICE_RESET, createdAt: { gte: startOfDay } } }),
    prisma.deviceSecurityEvent.groupBy({
      by: ["studentId"],
      where: { eventType: DeviceSecurityEventType.SUSPICIOUS_DEVICE_ACTIVITY, createdAt: { gte: new Date(now.getTime() - SUSPICIOUS_WINDOW_MS) } },
      _max: { createdAt: true },
    }),
    prisma.deviceSecurityEvent.groupBy({
      by: ["studentId"],
      where: { eventType: DeviceSecurityEventType.DEVICE_LIMIT_REACHED, createdAt: { gte: new Date(now.getTime() - LIMIT_REACHED_WINDOW_MS) } },
      _max: { createdAt: true },
    }),
    prisma.student.findMany({
      where: { status: { not: "DELETED" }, OR: [{ devices: { some: {} } }, { deviceSecurityEvents: { some: {} } }] },
      orderBy: { lastLoginAt: { sort: "desc", nulls: "last" } },
      take: limit,
      select: {
        id: true,
        studentId: true,
        name: true,
        email: true,
        mobile: true,
        lastLoginAt: true,
        deviceLimitResetAt: true,
        devices: { where: { active: true }, select: { id: true } },
        sessions: { where: { revokedAt: null, expiresAt: { gt: now }, device: { active: true } }, select: { id: true } },
      },
    }),
  ]);
  const suspicious = new Map(suspiciousRows.map((r) => [r.studentId, r._max.createdAt]));
  const blocks = new Map(blockRows.map((r) => [r.studentId, r._max.createdAt]));
  const rows = students.map((s) => {
    const status = deriveSecurityStatus({
      lastSuspiciousAt: suspicious.get(s.id) ?? null,
      lastBlockAt: blocks.get(s.id) ?? null,
      resetAt: s.deviceLimitResetAt,
      now: now.getTime(),
    });
    return {
      id: s.id,
      studentCode: s.studentId,
      name: s.name,
      email: s.email,
      mobile: s.mobile,
      devices: s.devices.length,
      activeSessions: s.sessions.length,
      lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
      resetAt: s.deviceLimitResetAt?.toISOString() ?? null,
      recentlyReset: !!s.deviceLimitResetAt && now.getTime() - s.deviceLimitResetAt.getTime() < SUSPICIOUS_WINDOW_MS,
      status,
    };
  });
  return {
    limit: settings.maxDevices,
    summary: {
      activeSessions,
      registeredDevices,
      blocksToday,
      suspiciousAccounts: rows.filter((r) => r.status === "SUSPICIOUS").length,
      resetsToday,
    },
    rows,
  };
}
