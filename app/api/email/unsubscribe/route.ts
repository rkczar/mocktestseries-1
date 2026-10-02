import { NextRequest, NextResponse } from "next/server";
import { setPromotionalOptOut, verifyPreferencesToken } from "@/lib/email/preferences";
import { getSiteUrl } from "@/lib/site-url";

/**
 * One-click unsubscribe (RFC 8058) — the target of the List-Unsubscribe
 * header on promotional email. Mail clients POST here with
 * "List-Unsubscribe=One-Click"; the signed token is the only credential and
 * can only opt that one student out of promotional email. A GET (someone
 * clicking the raw URL) goes to the preferences page instead of changing
 * anything, so link scanners can't unsubscribe people.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const studentId = verifyPreferencesToken(request.nextUrl.searchParams.get("token"));
  if (!studentId) return NextResponse.json({ ok: false }, { status: 400 });
  await setPromotionalOptOut(studentId, true, "one-click");
  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  return NextResponse.redirect(`${await getSiteUrl()}/email/preferences?token=${encodeURIComponent(token)}`, 303);
}
