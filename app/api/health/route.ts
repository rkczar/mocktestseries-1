import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Liveness + database reachability for the local watchdog
 * (ops/monitoring/mocktestseries-watchdog.sh) and any external uptime
 * monitor. Public and read-only: it reveals nothing beyond up/down.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok" }, { headers });
  } catch {
    return NextResponse.json({ status: "error", db: "unreachable" }, { status: 503, headers });
  }
}
