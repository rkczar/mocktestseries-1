import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudioSettings } from "@/lib/instagram/config";
import { StudioError, getPostDto } from "@/lib/instagram/posts";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { checkContentInput, checkDesignInput } from "@/lib/instagram/validate";

/**
 * Live slide preview for the editor: renders the post's frozen question
 * snapshot with the editor's UNSAVED content/design (validated exactly like a
 * save, never stored). MASTER_ADMIN only. Output is a private JPEG.
 */
const ID = /^[a-z0-9]{10,40}$/i;

export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }
  let body: { postId?: unknown; index?: unknown; content?: unknown; design?: unknown };
  try {
    const text = await request.text();
    if (text.length > 64_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body.postId !== "string" || !ID.test(body.postId)) return NextResponse.json({ error: "Invalid post." }, { status: 400 });
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index > 5) return NextResponse.json({ error: "Invalid slide." }, { status: 400 });
  try {
    const [post, settings] = await Promise.all([getPostDto(body.postId), getStudioSettings()]);
    const content = checkContentInput(body.content ?? post.content, post.content);
    if (!content.ok) return NextResponse.json({ error: content.error }, { status: 422 });
    const design = checkDesignInput(body.design ?? post.design);
    if (!design.ok) return NextResponse.json({ error: design.error }, { status: 422 });
    if (index >= design.value.modules.length) return NextResponse.json({ error: "Invalid slide." }, { status: 400 });
    const jpeg = await renderSlideJpeg(
      {
        snapshot: post.snapshot,
        content: content.value,
        design: design.value,
        series: post.series,
        seriesStats: post.seriesStats,
        questionNumber: post.questionNumber,
        questionNumberVerified: post.questionNumberVerified,
        settings,
      },
      index,
      85
    );
    return new NextResponse(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: 404 });
    console.error("[instagram-preview]", error);
    return NextResponse.json({ error: "Preview failed." }, { status: 500 });
  }
}
