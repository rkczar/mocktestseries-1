import { renderDefaultOgImage } from "@/lib/og/render";

// Rendered once at build time; the URL carries OG_ARTWORK_VERSION (lib/social-metadata.ts).
export const dynamic = "force-static";

export async function GET() {
  return renderDefaultOgImage();
}
