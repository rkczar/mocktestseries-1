import { NextResponse } from "next/server";
import { readPublishMedia } from "@/lib/instagram/publish";

/**
 * Public, read-only slide images for Instagram's servers to fetch while a
 * Master Admin publishes (lib/instagram/publish.ts). Only immutable JPEG
 * snapshots written for one publish job are served, under a random 192-bit
 * token, until they expire; anything else is a 404. No login, no DB access,
 * no question bank data — just the rendered image.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await params;
  const jpeg = await readPublishMedia(token, file);
  if (!jpeg) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  return new NextResponse(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(jpeg.length),
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
