import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Two entirely separate next-auth instances/cookies guard two entirely
 * separate route trees. getToken() (rather than the `auth(handler)`
 * middleware wrapper) lets one middleware.ts check both cookies by name —
 * an admin session token never satisfies /student/* and a student session
 * token never satisfies /admin/*, because each check only ever decodes its
 * own cookie.
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/admin")) {
    if (pathname === "/admin/login") return NextResponse.next();

    const token = await getToken({ req: request, secret: process.env.AUTH_SECRET });
    if (!token) {
      const loginUrl = new URL("/admin/login", request.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname);
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
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/student/:path*"],
};
