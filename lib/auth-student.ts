import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import argon2 from "argon2";
import { OtpPurpose, StudentAuthProvider, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { studentAuthConfig } from "@/lib/auth-student.config";
import { nextStudentId } from "@/lib/student-id";
import { verifyOtp } from "@/lib/otp";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 8;

function normalizeMobile(mobile: string) {
  return mobile.trim().replace(/[^\d+]/g, "");
}

export const {
  handlers,
  auth: studentServerAuth,
  signIn: studentSignIn,
  signOut: studentSignOut,
} = NextAuth({
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
        const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        if (!identifier || !password) return null;

        const windowStart = new Date(Date.now() - LOGIN_WINDOW_MS);
        const recentAttempts = await prisma.studentLoginAttempt.count({
          where: { identifier, ipAddress, createdAt: { gte: windowStart } },
        });
        if (recentAttempts >= MAX_ATTEMPTS_IN_WINDOW) {
          throw new Error("Too many login attempts. Please try again later.");
        }

        const student = await prisma.student.findFirst({
          where: { OR: [{ email: identifier }, { mobile: identifier }] },
        });

        let success = false;
        if (student?.passwordHash && student.status === StudentStatus.ACTIVE) {
          success = await argon2.verify(student.passwordHash, password).catch(() => false);
        }

        await prisma.studentLoginAttempt.create({
          data: { identifier, ipAddress, success, studentId: student?.id },
        });

        if (!student || !success) return null;

        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "password" } },
        });

        return {
          id: student.id,
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          authProvider: student.authProvider,
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
      async authorize(credentials) {
        const mobile = normalizeMobile(String(credentials?.mobile ?? ""));
        const code = String(credentials?.code ?? "");
        const mode = String(credentials?.mode ?? "login");
        if (!mobile || !code) return null;

        const purpose = mode === "register" ? OtpPurpose.REGISTER : OtpPurpose.LOGIN;
        await verifyOtp(mobile, purpose, code);

        if (mode === "register") {
          const existing = await prisma.student.findUnique({ where: { mobile } });
          if (existing) {
            throw new Error("An account with this mobile number already exists. Please login instead.");
          }
          const name = String(credentials?.name ?? "").trim();
          if (!name) throw new Error("Name is required.");
          const email = String(credentials?.email ?? "").trim().toLowerCase() || undefined;

          const studentId = await nextStudentId();
          const student = await prisma.student.create({
            data: { studentId, name, mobile, email, authProvider: StudentAuthProvider.OTP },
          });
          await prisma.studentProfile.create({ data: { studentId: student.id } });
          await prisma.studentActivity.create({
            data: { studentId: student.id, activity: "REGISTERED", metadata: { method: "otp" } },
          });

          return {
            id: student.id,
            studentId: student.studentId,
            name: student.name,
            email: student.email,
            authProvider: student.authProvider,
          };
        }

        const student = await prisma.student.findUnique({ where: { mobile } });
        if (!student || student.status !== StudentStatus.ACTIVE) {
          throw new Error("No account found for this mobile number.");
        }

        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "otp" } },
        });

        return {
          id: student.id,
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          authProvider: student.authProvider,
        };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
  ],
  callbacks: {
    ...studentAuthConfig.callbacks,
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      const providerAccountId = account.providerAccountId;
      const email = profile?.email?.toLowerCase();

      const existingLink = await prisma.studentOAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider: "GOOGLE", providerAccountId } },
        include: { student: true },
      });

      let student = existingLink?.student ?? null;

      if (!student && email) {
        student = await prisma.student.findUnique({ where: { email } });
        if (student) {
          await prisma.studentOAuthAccount.create({
            data: { studentId: student.id, provider: "GOOGLE", providerAccountId, email },
          });
        }
      }

      if (!student) {
        if (!email) return false;
        const studentId = await nextStudentId();
        student = await prisma.student.create({
          data: { studentId, name: profile?.name ?? "Student", email, authProvider: StudentAuthProvider.GOOGLE },
        });
        await prisma.studentProfile.create({
          data: {
            studentId: student.id,
            photoUrl: typeof profile?.picture === "string" ? profile.picture : undefined,
          },
        });
        await prisma.studentOAuthAccount.create({
          data: { studentId: student.id, provider: "GOOGLE", providerAccountId, email },
        });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "REGISTERED", metadata: { method: "google" } },
        });
      } else {
        await prisma.student.update({ where: { id: student.id }, data: { lastLoginAt: new Date() } });
        await prisma.studentActivity.create({
          data: { studentId: student.id, activity: "LOGIN", metadata: { method: "google" } },
        });
      }

      if (student.status !== StudentStatus.ACTIVE) return false;

      user.id = student.id;
      user.studentId = student.studentId;
      user.authProvider = student.authProvider;
      user.name = student.name;
      user.email = student.email;

      return true;
    },
  },
});
