import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { jsonPackageZip, richTemplateXlsx, richTemplateZip } from "@/lib/rich-import/template";
import { isJsonImportExampleId, jsonImportExampleText } from "@/lib/json-import-examples";

/**
 * Official import templates: ?file=xlsx (example rows + Instructions sheet), ?file=zip (sample image bundle),
 * ?file=json&example=<id> (docs/JSON-IMPORT.md examples) or ?file=json-package (questions.json + images).
 */
export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const params = new URL(request.url).searchParams;
    const kind = params.get("file");
    if (kind === "json") {
      const example = params.get("example");
      if (!isJsonImportExampleId(example)) return NextResponse.json({ error: "Unknown example." }, { status: 404 });
      return new NextResponse(jsonImportExampleText(example), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${example}.json"` },
      });
    }
    if (kind === "json-package") {
      return new NextResponse(new Uint8Array(await jsonPackageZip()), {
        headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="json-package-example.zip"' },
      });
    }
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
