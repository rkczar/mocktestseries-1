import type { NextAuthConfig } from "next-auth";
import { DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/permissions";

/**
 * Edge-safe NextAuth config: no Credentials provider, no argon2, no Prisma.
 * Middleware runs on the Edge runtime and can't bundle native Node addons
 * like argon2, so it gets only this config (via lib/auth-edge.ts) to verify
 * an already-issued session JWT. The real provider (with argon2 + Prisma)
 * lives in lib/auth.ts and is only ever imported from Node.js runtime code.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login" },
  trustHost: true,
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as { role: string }).role;
        token.permissions = DEFAULT_ROLE_PERMISSIONS[
          (user as { role: keyof typeof DEFAULT_ROLE_PERMISSIONS }).role
        ];
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        session.user.role = token.role as string | undefined;
        // Derive from the role on every request (not only the value frozen
        // into the JWT at sign-in) so newly added permission keys apply to
        // already-signed-in admins without forcing a re-login.
        const role = token.role as keyof typeof DEFAULT_ROLE_PERMISSIONS | undefined;
        session.user.permissions =
          (role && DEFAULT_ROLE_PERMISSIONS[role]) || (token.permissions as PermissionKey[] | undefined);
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
