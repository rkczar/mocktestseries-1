import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import argon2 from "argon2";
import { OtpPurpose, Prisma, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { studentAuthConfig } from "@/lib/auth-student.config";
import { nextStudentId } from "@/lib/student-id";
import { verifyOtp, OtpError } from "@/lib/otp";
import { getAuthProviderConfig, getGoogleCredentials } from "@/lib/auth-provider-config";
import { isStudentAuthEligible, resolveGoogleStudent } from "@/lib/student-lifecycle";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import { assertPlatformOpen, isPlatformOpen, PlatformPausedError } from "@/lib/platform-controls";
import { clientIpFromHeaders, getClientIp } from "@/lib/client-ip";
import { assertStudentPasswordLoginAllowed, assertOtpVerifyAllowed } from "@/lib/auth-rate-limit";
import {
  admitCurrentRequestSignIn,
  checkStudentToken,
  DeviceLimitError,
  revokeSessionBySecret,
  type AdmittedSignIn,
} from "@/lib/student-devices";
import { queueFirstLoginEmail, queueWelcomeEmail } from "@/lib/email/events";
import { parseIndianMobile, storedMobileVariants, INDIAN_MOBILE_ERROR } from "@/lib/indian-mobile";
import { findStudentsByMobile } from "@/lib/mobile-verification";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 8;

const ACCOUNT_EXISTS_MESSAGE = "An account with this mobile number already exists. Please sign in instead.";

/** Device/session claims the jwt callback copies into the token (see lib/auth-student.config.ts). */
function deviceClaims(admitted: AdmittedSignIn) {
  return {
    deviceId: admitted.deviceId,
    sessionSecret: admitted.sessionSecret,
    sessionRowId: admitted.sessionRowId,
    authAt: admitted.authAt,
  };
}


export const {
  handlers,
  auth: studentServerAuth,
  signIn: studentSignIn,
  signOut: studentSignOut,
} = NextAuth(async () => {
  // Re-read on every request so an Admin API Manager save (Google OAuth /
  // MSG91 / login-method toggles) takes effect immediately, with no restart.
  // getAuthProviderConfig() is cheap (15s in-process cache); the raw
  // credential decrypt is skipped entirely unless Google is actually
  // configured, so an unconfigured Google provider costs nothing extra on
  // every student page load.
  const providerConfig = await getAuthProviderConfig();
  const googleCreds = providerConfig.google.configured
    ? await getGoogleCredentials()
    : { clientId: null, clientSecret: null };

  return {
  ...studentAuthConfig,
  providers: [
    Credentials({
      id: "password",
      name: "Password",
      credentials: {
        identifier: { label: "Email or Mobile", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const identifier = String(credentials?.identifier ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        const ipAddress = clientIpFromHeaders(request.headers);
        if (!identifier || !password) return null;
        if (!providerConfig.passwordEnabled) {
          throw new Error("Password login is currently disabled.");
        }
        // Platform Controls → Student Login (also Lockdown / Maintenance).
        // Refuses NEW sessions only; existing session cookies stay valid.
        await assertPlatformOpen("login");

        const windowStart = new Date(Date.now() - LOGIN_WINDOW_MS);
        const recentAttempts = await prisma.studentLoginAttempt.count({
          where: { identifier, ipAddress, createdAt: { gte: windowStart } },
        });
        if (recentAttempts >= MAX_ATTEMPTS_IN_WINDOW) {
          throw new Error("Too many login attempts. Please try again later.");
        }
        await assertStudentPasswordLoginAllowed(identifier, ipAddress);

        // The form is labelled "User ID or Email" — User IDs are stored upper-case (MTS-000123).
        // A verified mobile is stored as +91XXXXXXXXXX: match the other spellings a student may type too.
        const asMobile = parseIndianMobile(identifier);
        const student = await prisma.student.findFirst({
          where: {
            OR: [
              { email: identifier },
              { mobile: identifier },
              ...(asMobile ? [{ mobile: { in: storedMobileVariants(asMobile) } }] : []),
              { studentId: identifier.toUpperCase() },
            ],
          },
        });

        let success = false;
        if (student?.passwordHash && isStudentAuthEligible(student.status)) {
          success = await argon2.verify(student.passwordHash, password).catch(() => false);
        }

        // Device limit, before any session exists. A blocked device records
        // its own DEVICE_LIMIT attempt and throws the student-facing message.
        const admitted = student && success ? await admitCurrentRequestSignIn(student.id, "PASSWORD", identifier) : null;

        await prisma.studentLoginAttempt.create({
          data: { identifier, ipAddress, success, method: "PASSWORD", studentId: student?.id },
        });

        if (!student || !success || !admitted) return null;

        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "password" } },
        });
        await queueFirstLoginEmail(student.id);

        return {
          id: student.id,
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          authProvider: student.authProvider,
          ...deviceClaims(admitted),
        };
      },
    }),
    Credentials({
      id: "otp",
      name: "Mobile OTP",
      credentials: {
        mobile: { label: "Mobile", type: "text" },
        code: { label: "Code", type: "text" },
        mode: { label: "Mode", type: "text" },
        name: { label: "Name", type: "text" },
        email: { label: "Email", type: "text" },
      },
      async authorize(credentials, request) {
        // Indian mobiles only, always handled as E.164 (the OTP was sent to that form).
        const parsedMobile = parseIndianMobile(String(credentials?.mobile ?? ""));
        const code = String(credentials?.code ?? "");
        const mode = String(credentials?.mode ?? "login");
        const ipAddress = clientIpFromHeaders(request.headers);
        if (!code) return null;
        if (!parsedMobile) throw new Error(INDIAN_MOBILE_ERROR);
        const mobile = parsedMobile.e164;
        // The Phone OTP sign-in toggle does not apply to Create Account, which
        // is mobile-OTP-first and governed by registerEnabled alone.
        if (!providerConfig.otpEnabled && mode !== "register") {
          throw new Error("Mobile OTP login is currently disabled.");
        }
        if (mode === "register" && !providerConfig.registerEnabled) {
          throw new Error("New account creation is currently disabled.");
        }
        // Platform Controls, checked before the OTP is consumed. Effective
        // registrations-open already implies effective login-open.
        await assertPlatformOpen(mode === "register" ? "registrations" : "login");

        const purpose = mode === "register" ? OtpPurpose.REGISTER : OtpPurpose.LOGIN;
        const attemptMethod = mode === "register" ? "CREATE_ACCOUNT" : "PHONE_OTP";

        await assertOtpVerifyAllowed(ipAddress);
        try {
          await verifyOtp(mobile, purpose, code);
        } catch (error) {
          await prisma.studentLoginAttempt.create({
            data: { identifier: mobile, ipAddress, success: false, method: attemptMethod },
          });
          throw error instanceof OtpError ? error : new Error("Verification failed. Please try again.");
        }

        if (mode === "register") {
          // Reached only after verifyOtp() succeeded above, in this same server
          // call: the account is created already verified, and nothing from the
          // browser decides that. Every older spelling of the number counts as taken.
          const existing = await findStudentsByMobile(parsedMobile);
          if (existing.length > 0) {
            await prisma.studentLoginAttempt.create({
              data: { identifier: mobile, ipAddress, success: false, method: attemptMethod, studentId: existing[0].id },
            });
            throw new Error(ACCOUNT_EXISTS_MESSAGE);
          }
          const name = String(credentials?.name ?? "").trim().replace(/\s+/g, " ");
          if (name.length < 2 || name.length > 80) throw new Error("Enter your full name (2–80 characters).");
          const email = String(credentials?.email ?? "").trim().toLowerCase() || undefined;

          const studentId = await nextStudentId();
          let student;
          try {
            student = await prisma.student.create({
              data: { studentId, name, mobile, mobileVerifiedAt: new Date(), email, authProvider: StudentAuthProvider.OTP },
            });
          } catch (error) {
            // Unique(mobile): a parallel sign-up with the same number won the race.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
              throw new Error(ACCOUNT_EXISTS_MESSAGE);
            }
            throw error;
          }
          await prisma.studentProfile.create({ data: { studentId: student.id } });
          await prisma.studentActivity.create({
            data: { studentId: student.id, activity: "REGISTERED", metadata: { method: "otp" } },
          });
          await ensureDefaultExamEnrollmentSafely(student.id);
          const admitted = await admitCurrentRequestSignIn(student.id, "CREATE_ACCOUNT", mobile);
          await prisma.studentLoginAttempt.create({
            data: { identifier: mobile, ipAddress, success: true, method: attemptMethod, studentId: student.id },
          });
          await queueWelcomeEmail(student.id);
          await queueFirstLoginEmail(student.id);

          return {
            id: student.id,
            studentId: student.studentId,
            name: student.name,
            email: student.email,
            authProvider: student.authProvider,
            ...deviceClaims(admitted),
          };
        }

        // OTP sign-in reaches only an account that PROVED this number: one
        // already verified, or one created by OTP sign-up (whose number was
        // OTP-checked at creation). A number merely typed into a password or
        // Google account is never trusted — that student signs in the usual way
        // and verifies from there. These answers come after the OTP succeeded,
        // so only the number's owner ever sees them.
        const candidates = (await findStudentsByMobile(parsedMobile)).filter((s) => isStudentAuthEligible(s.status));
        const verified = candidates.filter((s) => s.mobileVerifiedAt);
        const match =
          verified.length === 1
            ? verified[0]
            : verified.length === 0 && candidates.length === 1 && candidates[0].authProvider === StudentAuthProvider.OTP
              ? candidates[0]
              : null;
        if (!match) {
          await prisma.studentLoginAttempt.create({
            data: { identifier: mobile, ipAddress, success: false, method: attemptMethod, studentId: candidates[0]?.id },
          });
          throw new Error(
            candidates.length === 0
              ? "No account is linked to this mobile number. Please create a new account."
              : "This mobile number isn't verified on your account yet. Please sign in with your password or Google, then verify your number."
          );
        }
        if (!match.mobileVerifiedAt) {
          // OTP sign-up account proving its number again: record it as verified (E.164).
          await prisma.student.updateMany({
            where: { id: match.id, mobileVerifiedAt: null },
            data: { mobile, mobileVerifiedAt: new Date() },
          });
        }
        const student = await prisma.student.findUniqueOrThrow({ where: { id: match.id } });

        const admitted = await admitCurrentRequestSignIn(student.id, "OTP", mobile);

        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "otp" } },
        });
        await prisma.studentLoginAttempt.create({
          data: { identifier: mobile, ipAddress, success: true, method: attemptMethod, studentId: student.id },
        });
        await queueFirstLoginEmail(student.id);

        return {
          id: student.id,
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          authProvider: student.authProvider,
          ...deviceClaims(admitted),
        };
      },
    }),
    ...(googleCreds.clientId && googleCreds.clientSecret
      ? [
          Google({
            clientId: googleCreds.clientId,
            clientSecret: googleCreds.clientSecret,
            // Always show Google's account chooser: without it, "Continue with
            // Google" right after Logout silently signs the same Google
            // account back in (on a shared device, the previous student).
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  callbacks: {
    ...studentAuthConfig.callbacks,
    /**
     * Server-side session revocation. Student sessions are stateless JWTs,
     * so a deleted/suspended account's cookie would otherwise stay valid
     * until expiry. Every auth() call (pages, Server Actions, route
     * handlers — requireStudent() goes through here) re-checks the Student
     * row AND the device/session (checkStudentToken: revoked session,
     * revoked device, "log out all"); returning null makes Auth.js treat the
     * request as signed out and clear the cookie wherever it can write one.
     * Skipped on the sign-in call itself (`user` set), which just
     * authenticated against the DB and admitted the device.
     */
    async jwt(params) {
      const token = await studentAuthConfig.callbacks.jwt(params);
      if (params.user) return token;
      if (!token.studentDbId) return null;
      const check = await checkStudentToken({
        studentDbId: token.studentDbId,
        sid: token.sid,
        sref: token.sref,
        did: token.did,
        authAt: token.authAt,
        iat: typeof token.iat === "number" ? token.iat : undefined,
      });
      if (!check.ok) return null;
      // A pre-device-security token resolves its device from the cookie each request.
      if (check.deviceId) token.did = check.deviceId;
      return token;
    },
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      const ipAddress = await getClientIp();

      // Platform Controls → Student Login. Account creation is gated inside
      // resolveGoogleStudent, so an existing student still signs in while
      // only registrations are paused.
      if (!(await isPlatformOpen("login"))) return "/login?error=LoginPaused";

      if (!providerConfig.google.enabled) {
        await prisma.studentLoginAttempt.create({
          data: { identifier: profile?.email?.toLowerCase() ?? "unknown", ipAddress, success: false, method: "GOOGLE" },
        });
        return false;
      }

      const providerAccountId = account.providerAccountId;
      const email = profile?.email?.toLowerCase();

      let resolved: Awaited<ReturnType<typeof resolveGoogleStudent>>;
      try {
        resolved = await resolveGoogleStudent({
          providerAccountId,
          email,
          name: profile?.name ?? null,
          picture: typeof profile?.picture === "string" ? profile.picture : null,
        });
      } catch (error) {
        if (error instanceof PlatformPausedError) return "/login?error=RegistrationPaused";
        throw error;
      }
      if (!resolved) return false;
      const { student } = resolved;

      if (!isStudentAuthEligible(student.status)) {
        await prisma.studentLoginAttempt.create({
          data: { identifier: email ?? "unknown", ipAddress, success: false, method: "GOOGLE", studentId: student.id },
        });
        return false;
      }
      let admitted: AdmittedSignIn;
      try {
        admitted = await admitCurrentRequestSignIn(student.id, "GOOGLE", email ?? "unknown");
      } catch (error) {
        if (error instanceof DeviceLimitError) return "/login?error=DeviceLimit";
        throw error;
      }

      if (!resolved.created) {
        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "google" } },
        });
      }

      await prisma.studentLoginAttempt.create({
        data: { identifier: email ?? "unknown", ipAddress, success: true, method: "GOOGLE", studentId: student.id },
      });
      if (resolved.created) await queueWelcomeEmail(student.id);
      await queueFirstLoginEmail(student.id);

      user.id = student.id;
      user.studentId = student.studentId;
      user.authProvider = student.authProvider;
      user.name = student.name;
      user.email = student.email;
      Object.assign(user, deviceClaims(admitted));

      return true;
    },
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : undefined;
      try {
        if (token?.sid) await revokeSessionBySecret(token.sid as string, "LOGOUT");
      } catch {
        // best-effort; the JWT cookie is cleared regardless
      }
      try {
        await prisma.studentLoginAttempt.create({
          data: {
            identifier: (token?.studentId as string | undefined) ?? "unknown",
            ipAddress: "n/a",
            success: true,
            method: "LOGOUT",
            studentId: token?.studentDbId as string | undefined,
          },
        });
      } catch {
        // best-effort telemetry only — never block sign-out on a logging failure
      }
    },
  },
  };
});
