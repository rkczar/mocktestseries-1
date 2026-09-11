import { verify } from "@node-rs/argon2";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { ADMIN_SESSION_COOKIE } from "@/lib/auth/constants";
import { prisma } from "@/lib/db";

const {
  handlers: adminHandlers,
  auth: adminAuth,
  signIn: adminSignIn,
  signOut: adminSignOut,
} = NextAuth({
  basePath: "/api/auth/admin",
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const admin = await prisma.adminUser.findUnique({ where: { email } });
        if (!admin?.isActive) return null;

        const isValid = await verify(admin.passwordHash, password);
        if (!isValid) return null;

        await prisma.adminUser.update({
          where: { id: admin.id },
          data: { lastLoginAt: new Date() },
        });

        return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login" },
  cookies: {
    sessionToken: {
      name: ADMIN_SESSION_COOKIE,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = (user as { role: "ADMIN" | "SUPER_ADMIN" }).role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.role = token.role as "ADMIN" | "SUPER_ADMIN";
      }
      return session;
    },
  },
  secret: process.env.AUTH_ADMIN_SECRET,
});

export { adminHandlers, adminAuth, adminSignIn, adminSignOut };
