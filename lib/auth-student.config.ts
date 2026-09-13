import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe NextAuth config for the Student auth instance — mirrors the
 * split used for Admin (lib/auth.config.ts / lib/auth-edge.ts): no
 * Credentials/Google providers or Prisma here, since middleware runs on the
 * Edge runtime. The real providers live in lib/auth-student.ts.
 *
 * Distinct cookie names (`student-session-token`, `student-csrf-token`,
 * `student-callback-url` vs next-auth's `authjs.*` defaults used by the
 * Admin instance) guarantee an admin session and a student session are
 * never the same credential, and that neither dashboard is reachable with
 * the other's session. All three must be renamed, not just sessionToken —
 * next-auth does not scope cookies by `basePath`, so leaving csrfToken/
 * callbackUrl at their defaults would have both instances read and write
 * the exact same two cookies in the same browser.
 */
export const studentAuthConfig = {
  basePath: "/api/student-auth",
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [],
  cookies: {
    sessionToken: {
      name: "student-session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
    csrfToken: {
      name: "student-csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
    callbackUrl: {
      name: "student-callback-url",
      options: {
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.studentDbId = user.id;
        token.studentId = user.studentId;
        token.authProvider = user.authProvider;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (token.studentDbId) session.user.id = token.studentDbId as string;
        session.user.studentId = token.studentId as string | undefined;
        session.user.authProvider = token.authProvider as string | undefined;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
