import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { auth as adminAuth } from "@/lib/auth-edge";
import { DEVICE_COOKIE_NAME, deviceCookieOptions, mintDeviceCookieValue, verifyDeviceCookieValue } from "@/lib/device-cookie";
import { getPlatformControls, DEFAULT_MAINTENANCE_MESSAGE, DEFAULT_MAINTENANCE_TITLE, type MaintenanceState } from "@/lib/platform-controls";
import { checkStudentToken } from "@/lib/student-devices";
import { STUDENT_PATH_HEADER } from "@/lib/student-path";

const STUDENT_SESSION_COOKIE = "student-session-token";

/**
 * The jwt callback's revocation rule (lib/auth-student.ts → checkStudentToken)
 * for an already-decoded student token. Legacy pre-device-security tokens
 * resolve to "alive" here (no device cookie lookup, no device registration);
 * the page's own auth() call still applies the full rule to them.
 */
async function studentTokenAlive(token: Record<string, unknown>, route: string): Promise<boolean> {
  if (typeof token.studentDbId !== "string") return false;
  try {
    const check = await checkStudentToken(
      {
        studentDbId: token.studentDbId,
        sid: token.sid as string | undefined,
        sref: token.sref as string | undefined,
        did: token.did as string | undefined,
        authAt: token.authAt as number | undefined,
        iat: typeof token.iat === "number" ? token.iat : undefined,
      },
      async () => null
    );
    // Ids and the reason only — never the token, cookie or session secret.
    if (!check.ok) console.warn(`[auth] ${JSON.stringify({ event: "student-session-rejected", route, student: token.studentDbId, reason: check.reason })}`);
    return check.ok;
  } catch (error) {
    // A database hiccup must not log everyone out; the page re-checks anyway.
    console.error("[auth] proxy session check failed", { code: (error as { code?: string })?.code ?? "UNKNOWN" });
    return true;
  }
}

/**
 * Platform Controls → Maintenance Mode. While ON, every request outside
 * this allowlist gets a 503 maintenance page (Retry-After, noindex, so
 * search engines keep the real pages). Allowed through:
 *   - Admin (pages, admin auth, admin APIs): the recovery path.
 *   - /api/health: the watchdog and the deploy script's health checks.
 *   - /api/webhooks: Razorpay capture/refund fulfilment for existing orders.
 *   - Checkout + invoices: verification and receipts for in-flight orders
 *     (creating a NEW order is refused by createCheckoutOrder itself).
 *   - /student/attempt: a student mid-test can save and submit; starting a
 *     new attempt is refused by the Start New Tests gate.
 * Everything else that maintenance pauses (login, registration, payments,
 * test starts, AI) is also refused at its own server entry point, so this
 * page is the friendly front, not the only lock.
 */
const MAINTENANCE_ALLOW = [
  "/admin",
  "/api/auth",
  "/api/admin",
  "/api/health",
  "/api/webhooks",
  "/api/student/invoices",
  "/student/checkout",
  "/student/attempt",
  "/storage/test-resources",
];

function maintenanceAllowed(pathname: string) {
  return MAINTENANCE_ALLOW.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function maintenanceResponse(request: NextRequest, m: MaintenanceState) {
  const headers = { "Retry-After": "300", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse("Service temporarily unavailable for maintenance.", { status: 503, headers });
  }
  const title = escapeHtml(m.title || DEFAULT_MAINTENANCE_TITLE);
  const message = escapeHtml(m.message || DEFAULT_MAINTENANCE_MESSAGE);
  const eta = m.eta ? `<p class="eta">Expected back: ${escapeHtml(m.eta)}</p>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} — Mock Test Series.in</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1020;color:#e5e7eb;padding:16px}main{max-width:480px;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:#9ca3af;line-height:1.6;margin:.5rem 0}.eta{color:#fbbf24}</style></head><body><main><h1>${title}</h1><p>${message}</p>${eta}</main></body></html>`;
  return new NextResponse(html, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Student device cookie (lib/device-cookie.ts). Guaranteed on every student
 * auth surface BEFORE a sign-in runs, so the login Server Actions and the
 * Google callback can always identify the device. A fresh value is also
 * injected into this request's Cookie header, so even the very first
 * request from a new browser sees it. Never set on /admin.
 */
async function withDeviceCookie(
  request: NextRequest,
  respond: (init?: { request: { headers: Headers } }) => NextResponse,
  extraHeaders?: Record<string, string>
): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  if (await verifyDeviceCookieValue(request.cookies.get(DEVICE_COOKIE_NAME)?.value)) {
    return extraHeaders ? respond({ request: { headers } }) : respond();
  }
  const value = await mintDeviceCookieValue();
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
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!maintenanceAllowed(pathname)) {
    const { maintenance } = await getPlatformControls();
    if (maintenance.on) return maintenanceResponse(request, maintenance);
  }

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
    // Full path + query (not just pathname) so a deep link into a specific
    // resource (e.g. /student/attempt/resume?paper=<id>) survives the login
    // round-trip. The RSC cache-buster is not part of the destination.
    const search = new URLSearchParams(request.nextUrl.search);
    search.delete("_rsc");
    const destination = pathname + (search.size > 0 ? `?${search}` : "");
    const token = await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      cookieName: STUDENT_SESSION_COOKIE,
    });
    // A cookie that still decodes is not proof of a session: logout on
    // another tab, "log out all devices", a revoked device or a suspended
    // account all leave a decodable JWT behind. Pages would then reject it
    // (requireStudent) after the proxy had let it through — the "page
    // couldn't load" / bounced-to-login reports. Page loads re-check it here
    // with the same server-side rule the jwt callback uses, so a dead session
    // goes to /login with its destination intact and the stale cookie is
    // dropped. Server Actions (POST) keep requireStudentOrLogin().
    const isPageLoad = request.method === "GET" || request.method === "HEAD";
    if (!token || (isPageLoad && !(await studentTokenAlive(token, pathname)))) {
      const loginUrl = new URL("/login", request.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", destination);
      return withDeviceCookie(request, () => {
        const response = NextResponse.redirect(loginUrl);
        if (token) response.cookies.set(STUDENT_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
        return response;
      });
    }
    return withDeviceCookie(request, (init) => NextResponse.next(init), { [STUDENT_PATH_HEADER]: destination });
  }

  return NextResponse.next();
}

export const config = {
  // Every page and API route (for the Maintenance gate), excluding Next's
  // static assets and plain files such as images; test-resource files are
  // re-included for their Admin-only check.
  matcher: ["/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)", "/storage/test-resources/:path*"],
};
