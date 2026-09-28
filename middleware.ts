import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { auth as adminAuth } from "@/lib/auth-edge";
import { DEVICE_COOKIE_NAME, deviceCookieOptions, mintDeviceCookieValue, verifyDeviceCookieValue } from "@/lib/device-cookie";

/**
 * Student device cookie (lib/device-cookie.ts). Guaranteed on every student
 * auth surface BEFORE a sign-in runs, so the login Server Actions and the
 * Google callback can always identify the device. A fresh value is also
 * injected into this request's Cookie header, so even the very first
 * request from a new browser sees it. Never set on /admin.
 */
async function withDeviceCookie(
  request: NextRequest,
  respond: (init?: { request: { headers: Headers } }) => NextResponse
): Promise<NextResponse> {
  if (await verifyDeviceCookieValue(request.cookies.get(DEVICE_COOKIE_NAME)?.value)) return respond();
  const value = await mintDeviceCookieValue();
  const headers = new Headers(request.headers);
  const others = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${DEVICE_COOKIE_NAME}=`));
  headers.set("cookie", [...others, `${DEVICE_COOKIE_NAME}=${value}`].join("; "));
  const response = respond({ request: { headers } });
  response.cookies.set(DEVICE_COOKIE_NAME, value, deviceCookieOptions);
  return response;
}

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

  // Paper/Solution PDFs live under public/storage, which Next would serve to
  // anyone with the URL. Students get them only through the access-checked
  // /api/student/test-resources/[id] route; the raw file is Admin-only.
  if (pathname.startsWith("/storage/test-resources/")) {
    const session = await adminAuth();
    if (!session?.user) return new NextResponse("Not found", { status: 404 });
    return NextResponse.next();
  }

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

  if (
    pathname === "/login" ||
    pathname.startsWith("/api/student-auth") ||
    pathname === "/student/login" ||
    pathname === "/student/register"
  ) {
    return withDeviceCookie(request, (init) => NextResponse.next(init));
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
      return withDeviceCookie(request, () => NextResponse.redirect(loginUrl));
    }
    return withDeviceCookie(request, (init) => NextResponse.next(init));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/student/:path*", "/login", "/api/student-auth/:path*", "/storage/test-resources/:path*"],
};
