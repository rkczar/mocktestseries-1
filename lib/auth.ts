import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 8;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        username: { label: "Admin ID / Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const username = String(credentials?.username ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        const ipAddress =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

        if (!username || !password) return null;

        const windowStart = new Date(Date.now() - LOGIN_WINDOW_MS);
        const recentAttempts = await prisma.loginAttempt.count({
          where: { username, ipAddress, createdAt: { gte: windowStart } },
        });
        if (recentAttempts >= MAX_ATTEMPTS_IN_WINDOW) {
          throw new Error("TooManyAttempts");
        }

        const adminUser = await prisma.adminUser.findUnique({
          where: { username },
          include: { role: true },
        });

        let success = false;
        if (adminUser && adminUser.isActive) {
          success = await argon2.verify(adminUser.passwordHash, password).catch(() => false);
        }

        await prisma.loginAttempt.create({
          data: { username, ipAddress, success, adminUserId: adminUser?.id },
        });

        if (!adminUser || !adminUser.isActive || !success) return null;

        await prisma.adminUser.update({
          where: { id: adminUser.id },
          data: { lastLoginAt: new Date() },
        });

        await prisma.auditLog.create({
          data: {
            actorId: adminUser.id,
            action: "ADMIN_LOGIN",
            entityType: "AdminUser",
            entityId: adminUser.id,
          },
        });

        return {
          id: adminUser.id,
          name: adminUser.name,
          email: adminUser.email ?? undefined,
          role: adminUser.role.name,
        };
      },
    }),
  ],
});
