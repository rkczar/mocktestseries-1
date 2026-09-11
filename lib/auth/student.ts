import { verify } from "@node-rs/argon2";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { STUDENT_SESSION_COOKIE } from "@/lib/auth/constants";
import { prisma } from "@/lib/db";

const {
  handlers: studentHandlers,
  auth: studentAuth,
  signIn: studentSignIn,
  signOut: studentSignOut,
} = NextAuth({
  basePath: "/api/auth/student",
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const student = await prisma.student.findUnique({ where: { email } });
        if (!student?.passwordHash || !student.isActive) return null;

        const isValid = await verify(student.passwordHash, password);
        if (!isValid) return null;

        return { id: student.id, email: student.email, name: student.name };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/student/login" },
  cookies: {
    sessionToken: {
      name: STUDENT_SESSION_COOKIE,
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
        token.role = "student";
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
      }
      return session;
    },
  },
  secret: process.env.AUTH_STUDENT_SECRET,
});

export { studentHandlers, studentAuth, studentSignIn, studentSignOut };
