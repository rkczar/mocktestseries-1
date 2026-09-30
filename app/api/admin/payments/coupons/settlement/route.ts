import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parsePaymentFilters } from "@/lib/payments/analytics";
import { getCouponSettlementRows, settlementCsv } from "@/lib/payments/coupon-report";

export const dynamic = "force-dynamic";

/**
 * Creator / coupon settlement CSV (successful orders only). Read-only, so
 * PAYMENTS_VIEW is enough. Query: env=LIVE|TEST (default LIVE), from/to
 * (YYYY-MM-DD, IST, on paid date), coupon=<id>, creator=<text>. Students
 * appear only as a masked Student ID — no names, emails or phone numbers.
 */
export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.PAYMENTS_VIEW);
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const f = parsePaymentFilters(sp);
  const creator = typeof sp.creator === "string" ? sp.creator.trim().slice(0, 100) || null : null;
  const rows = await getCouponSettlementRows({ environment: f.environment, from: f.from, to: f.to, couponId: f.couponId, creator });
  const stamp = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return new NextResponse(settlementCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="coupon-settlement-${f.environment}-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
