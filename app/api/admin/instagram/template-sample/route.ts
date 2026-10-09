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
  if (!t || !Number.isInteger(i) || i < 0 || i > 4) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const jpeg = await renderSlideJpeg(sampleWith(await getStudioSettings(), defaultDesign(t, 5)), i, 80);
  return new NextResponse(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
}
