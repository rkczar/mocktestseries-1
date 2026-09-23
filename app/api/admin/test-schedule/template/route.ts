import { NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { buildScheduleTemplateCsv } from "@/lib/schedule-import";

export async function GET() {
  try {
    await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  return new NextResponse(buildScheduleTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule-template.csv"',
    },
  });
}
