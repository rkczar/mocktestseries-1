import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudioSettings } from "@/lib/instagram/config";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { sampleWith } from "@/lib/instagram/sample";
import { TEMPLATE_KEYS, defaultDesign, type TemplateKey } from "@/lib/instagram/types";

/** Templates & Branding: one slide of the SYNTHETIC sample carousel in a template, with the live studio settings. MASTER_ADMIN only. */
export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }
  const p = request.nextUrl.searchParams;
  const t = TEMPLATE_KEYS.find((k) => k === p.get("t")) as TemplateKey | undefined;
  const i = Number(p.get("i") ?? "0");
  // n=7 shows the universal medical carousel (Question … Diagram, Pearls, Mistakes, Trap, Follow); default is the 5-slide layout.
  const n = p.get("n") === "7" ? 7 : 5;
  if (!t || !Number.isInteger(i) || i < 0 || i >= n) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const jpeg = await renderSlideJpeg(sampleWith(await getStudioSettings(), defaultDesign(t, n)), i, 80);
  return new NextResponse(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
}
