import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { STATE_COOKIE, STATE_COOKIE_PATH, appOrigin, completeAuthorization } from "@/lib/seo-intel/google";

/**
 * Google OAuth redirect target for the shared SEO Intelligence connection
 * (must be registered on the SEO OAuth client as exactly
 * <origin>/api/admin/seo-intel/google/callback). MASTER_ADMIN only; the flow
 * must have been started by the same admin in this browser (encrypted state
 * cookie). Always clears that cookie and never echoes a code or token back.
 */
function back(status: string, reason?: string) {
  const url = new URL("/admin/seo/intelligence", appOrigin());
  url.searchParams.set("google", status);
  if (reason) url.searchParams.set("reason", reason);
  const res = NextResponse.redirect(url, 303);
  res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure: appOrigin().startsWith("https://") });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session?.user?.id) {
    const res = NextResponse.redirect(new URL("/admin/login", appOrigin()), 303);
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    return res;
  }
  if (!session.user.permissions?.includes(PERMISSIONS.SEO_INTEL_MANAGE)) return back("error", "forbidden");

  const params = request.nextUrl.searchParams;
  const result = await completeAuthorization({
    adminId: session.user.id,
    cookieValue: request.cookies.get(STATE_COOKIE)?.value,
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  });

  if (result.ok) {
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "SEO_GOOGLE_CONNECTED",
        entityType: "Setting",
        entityId: "seo.google.oauth",
        metadata: { accountEmail: result.email, scopes: result.scopes },
      },
    });
    return back("connected");
  }
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "SEO_GOOGLE_CONNECT_FAILED",
      entityType: "Setting",
      entityId: "seo.google.oauth",
      metadata: { reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) },
    },
  });
  return back("error", result.reason);
}
