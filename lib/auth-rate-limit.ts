import "server-only";
import { prisma } from "@/lib/prisma";
import { UNKNOWN_IP } from "@/lib/client-ip";

/**
 * Central abuse limits for authentication (admin login, student password
 * login, OTP send/verify, password reset). Every limit is counted from rows
 * the auth flows already write (LoginAttempt, StudentLoginAttempt,
 * OtpRequest) — no extra table, and a BLOCKED request writes nothing, so a
 * blocked attacker cannot grow the tables. IPs come only from
 * lib/client-ip.ts (the trusted resolver).
 *
 * Limit errors carry one fixed, generic message that says nothing about
 * whether an account/number exists.
 */

const WINDOW_15_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const AUTH_LIMITS = {
  /** Failed password logins from one IP, any identifier (credential stuffing). */
  passwordFailuresPerIp: { max: 20, windowMs: WINDOW_15_MIN },
  /** Failed password logins for one identifier, any IP (distributed guessing). */
  passwordFailuresPerIdentifier: { max: 10, windowMs: WINDOW_15_MIN },
  /** OTP codes sent to requests from one IP. */
  otpSendsPerIp: { max: 10, windowMs: WINDOW_15_MIN },
  otpSendsPerIpDaily: { max: 30, windowMs: DAY },
  /** OTP codes sent to one mobile per day (the 15-minute per-mobile cap + cooldown live in lib/otp.ts). */
  otpSendsPerMobileDaily: { max: 10, windowMs: DAY },
  /** Provider-wide ceiling: total OTP sends across the platform (SMS cost circuit breaker). */
  otpSendsGlobalHourly: { max: 200, windowMs: HOUR },
  otpSendsGlobalDaily: { max: 1000, windowMs: DAY },
  /** Failed OTP verifications (login, sign-up, password reset) from one IP. */
  otpVerifyFailuresPerIp: { max: 20, windowMs: WINDOW_15_MIN },
} as const;

export const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Please try again later.";

export class AuthRateLimitError extends Error {
  constructor(message = TOO_MANY_ATTEMPTS_MESSAGE) {
    super(message);
    this.name = "AuthRateLimitError";
  }
}

const since = (windowMs: number) => new Date(Date.now() - windowMs);
const knownIp = (ip: string) => Boolean(ip) && ip !== UNKNOWN_IP;

export const OTP_VERIFY_METHODS = ["PHONE_OTP", "CREATE_ACCOUNT", "PASSWORD_RESET_VERIFY"];

/** Student password login: per-IP and per-identifier failure caps. */
export async function assertStudentPasswordLoginAllowed(identifier: string, ip: string): Promise<void> {
  const { passwordFailuresPerIp: perIp, passwordFailuresPerIdentifier: perId } = AUTH_LIMITS;
  const [ipFailures, idFailures] = await Promise.all([
    knownIp(ip)
      ? prisma.studentLoginAttempt.count({ where: { ipAddress: ip, method: "PASSWORD", success: false, createdAt: { gte: since(perIp.windowMs) } } })
      : 0,
    prisma.studentLoginAttempt.count({ where: { identifier, method: "PASSWORD", success: false, createdAt: { gte: since(perId.windowMs) } } }),
  ]);
  if (ipFailures >= perIp.max || idFailures >= perId.max) throw new AuthRateLimitError();
}

/** Admin login: per-IP and per-username failure caps. */
export async function isAdminLoginBlocked(username: string, ip: string): Promise<boolean> {
  const { passwordFailuresPerIp: perIp, passwordFailuresPerIdentifier: perId } = AUTH_LIMITS;
  const [ipFailures, userFailures] = await Promise.all([
    knownIp(ip) ? prisma.loginAttempt.count({ where: { ipAddress: ip, success: false, createdAt: { gte: since(perIp.windowMs) } } }) : 0,
    prisma.loginAttempt.count({ where: { username, success: false, createdAt: { gte: since(perId.windowMs) } } }),
  ]);
  return ipFailures >= perIp.max || userFailures >= perId.max;
}

/** OTP send: per-IP (15 min + daily), per-mobile daily, and the global provider ceiling. */
export async function assertOtpSendAllowed(mobile: string, ip: string): Promise<void> {
  const L = AUTH_LIMITS;
  const [ip15, ipDay, mobileDay, globalHour, globalDay] = await Promise.all([
    knownIp(ip) ? prisma.otpRequest.count({ where: { ipAddress: ip, createdAt: { gte: since(L.otpSendsPerIp.windowMs) } } }) : 0,
    knownIp(ip) ? prisma.otpRequest.count({ where: { ipAddress: ip, createdAt: { gte: since(L.otpSendsPerIpDaily.windowMs) } } }) : 0,
    prisma.otpRequest.count({ where: { mobile, createdAt: { gte: since(L.otpSendsPerMobileDaily.windowMs) } } }),
    prisma.otpRequest.count({ where: { createdAt: { gte: since(L.otpSendsGlobalHourly.windowMs) } } }),
    prisma.otpRequest.count({ where: { createdAt: { gte: since(L.otpSendsGlobalDaily.windowMs) } } }),
  ]);
  if (globalHour >= L.otpSendsGlobalHourly.max || globalDay >= L.otpSendsGlobalDaily.max) {
    // Circuit breaker tripped — operators must see this; never log the number or a code.
    console.warn("[auth-rate-limit] global OTP send ceiling reached", { globalHour, globalDay });
    throw new AuthRateLimitError();
  }
  if (ip15 >= L.otpSendsPerIp.max || ipDay >= L.otpSendsPerIpDaily.max || mobileDay >= L.otpSendsPerMobileDaily.max) {
    throw new AuthRateLimitError();
  }
}

/** OTP verify (login, sign-up, password reset): per-IP failure cap, checked before any verification. */
export async function assertOtpVerifyAllowed(ip: string): Promise<void> {
  if (!knownIp(ip)) return;
  const { otpVerifyFailuresPerIp: L } = AUTH_LIMITS;
  const failures = await prisma.studentLoginAttempt.count({
    where: { ipAddress: ip, method: { in: OTP_VERIFY_METHODS }, success: false, createdAt: { gte: since(L.windowMs) } },
  });
  if (failures >= L.max) throw new AuthRateLimitError();
}
