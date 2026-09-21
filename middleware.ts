import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { auth as adminAuth } from "@/lib/auth-edge";

/**
 * Two entirely separate next-auth instances/cookies guard two entirely
 * separate route trees. The admin instance uses Auth.js's default cookie
 * name, which gets an automatic `__Secure-` prefix under HTTPS — behind
 * this app's TLS-terminating nginx proxy, a raw getToken() call can't
 * reliably agree with that prefixing, so the admin branch uses the
 * edge-safe auth() from lib/auth-edge.ts instead (the same code path that
 * sets the cookie, so it can't disagree with itself). The student instance
 * was given an explicit custom cookie name specifically to sidestep this,
 * so getToken() with that name is reliable for it.
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (pathname === "/admin/login") return NextResponse.next();

    const session = await adminAuth();
    if (!session?.user) {
      const loginUrl = new URL("/admin/login", request.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  if (pathname === "/student/login" || pathname === "/student/register") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/student")) {
    const token = await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      cookieName: "student-session-token",
    });
    if (!token) {
      const loginUrl = new URL("/login", request.nextUrl.origin);
      // Preserve the full path + query (not just pathname) so a deep link
      // into a specific resource (e.g. /student/attempt/resume?paper=<id>)
      // survives the login round-trip instead of dropping which resource
      // the visitor was trying to reach.
      loginUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/student/:path*"],
};
