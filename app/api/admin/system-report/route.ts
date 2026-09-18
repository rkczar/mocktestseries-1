import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { generateSystemReport, systemReportFilename } from "@/lib/system-report";

/**
 * Generates the Live System Report fresh on every request — nothing is
 * cached or written to disk here. Gated behind SETTINGS_MANAGE (same gate as
 * the System page's Git Repository / Storage panels) because this report
 * aggregates disclosure across every admin module at once, a broader
 * surface than any single module's own page.
 */
export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    throw err;
  }

  const format = new URL(request.url).searchParams.get("format") === "txt" ? "txt" : "md";

  let markdown: string, text: string, generatedAt: Date;
  try {
    ({ markdown, text, generatedAt } = await generateSystemReport());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Report generation failed" }, { status: 500 });
  }

  const body = format === "txt" ? text : markdown;
  const filename = systemReportFilename(generatedAt, format);

  return new NextResponse(body, {
    headers: {
      "Content-Type": format === "txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
