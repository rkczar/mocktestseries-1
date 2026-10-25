import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudioSettings } from "@/lib/instagram/config";
import { StudioError, getPostDto } from "@/lib/instagram/posts";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { MAX_SLIDES } from "@/lib/instagram/types";
import { slideSequence } from "@/lib/instagram/layout";

/**
 * A saved post's slide as the final 1080 × 1350 JPEG (?postId=…&i=0-based,
 * &download=1 for an attachment). MASTER_ADMIN only; private, never cached
 * publicly. This is what the (not yet built) publishing step would upload.
 */
const ID = /^[a-z0-9]{10,40}$/i;

export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }
  const params = request.nextUrl.searchParams;
  const postId = params.get("postId") ?? "";
  const index = Number(params.get("i"));
  if (!ID.test(postId) || !Number.isInteger(index) || index < 0 || index >= MAX_SLIDES + 3) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  try {
    const [post, settings] = await Promise.all([getPostDto(postId), getStudioSettings()]);
    if (index >= slideSequence(post.content, post.design).length) return NextResponse.json({ error: "Invalid slide." }, { status: 400 });
    // A downloaded (exported) image never contains a missing-glyph box: undrawable characters must be fixed first
    // (Checks → Fix This Error). In-app thumbnails still render, with "□" marking the problem.
    const glyphs = post.issues.filter((i) => i.code.startsWith("GLYPHS:"));
    if (glyphs.length && params.get("download") === "1") return NextResponse.json({ error: `Fix the unsupported characters first (Checks tab): ${glyphs.map((g) => g.message).join(" ")}` }, { status: 409 });
    const jpeg = await renderSlideJpeg(
      {
        snapshot: post.snapshot,
        content: post.content,
        design: post.design,
        series: post.series,
        seriesStats: post.seriesStats,
        questionNumber: post.questionNumber,
        questionNumberVerified: post.questionNumberVerified,
        settings,
      },
      index
    );
    const headers: Record<string, string> = { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" };
    if (params.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="${post.questionCode.replace(/[^A-Za-z0-9_-]/g, "_")}-v${post.version}-r${post.revision}-slide-${index + 1}.jpg"`;
    return new NextResponse(new Uint8Array(jpeg), { headers });
  } catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: 404 });
    console.error("[instagram-slide]", error);
    return NextResponse.json({ error: "Render failed." }, { status: 500 });
  }
}
