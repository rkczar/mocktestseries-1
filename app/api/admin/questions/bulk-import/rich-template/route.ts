import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { richTemplateXlsx, richTemplateZip } from "@/lib/rich-import/template";

/** Official rich-import template: ?file=xlsx (example rows + Instructions sheet) or ?file=zip (sample image bundle). */
export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const kind = new URL(request.url).searchParams.get("file");
    if (kind === "zip") {
      return new NextResponse(new Uint8Array(await richTemplateZip()), {
        headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="rich-import-sample-images.zip"' },
      });
    }
    return new NextResponse(new Uint8Array(richTemplateXlsx()), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="rich-import-template.xlsx"',
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET rich-template error:", error);
    return NextResponse.json({ error: "Failed to build the template" }, { status: 500 });
  }
}
