import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

/** Edge-safe `auth()` for middleware only — see lib/auth.config.ts. */
export const { auth } = NextAuth(authConfig);
