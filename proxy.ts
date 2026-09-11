import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ADMIN_SESSION_COOKIE, STUDENT_SESSION_COOKIE } from "@/lib/auth/constants";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/student") && !pathname.startsWith("/student/login") && !pathname.startsWith("/student/register")) {
    const token = await getToken({
      req,
      secret: process.env.AUTH_STUDENT_SECRET,
      cookieName: STUDENT_SESSION_COOKIE,
      salt: STUDENT_SESSION_COOKIE,
    });
    if (!token || token.role !== "student") {
      const url = new URL("/student/login", req.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login")) {
    const token = await getToken({
      req,
      secret: process.env.AUTH_ADMIN_SECRET,
      cookieName: ADMIN_SESSION_COOKIE,
      salt: ADMIN_SESSION_COOKIE,
    });
    if (!token || (token.role !== "ADMIN" && token.role !== "SUPER_ADMIN")) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/student/:path*", "/admin/:path*"],
};
