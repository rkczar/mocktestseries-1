import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/rbac";
import { generateStudentDataReport, studentDataReportFilename } from "@/lib/student-data-report";

/**
 * Privileged per-student export — MASTER_ADMIN only, checked by role rather
 * than a permission key, per spec: global read-only Admin access (FULL_ADMIN)
 * must never imply access to this. `includeContact=1` is a separate explicit
 * opt-in on top of the role gate, never the default.
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session?.user || session.user.role !== "MASTER_ADMIN") {
    return NextResponse.json({ error: "MASTER_ADMIN only" }, { status: 403 });
  }

  const includeContact = new URL(request.url).searchParams.get("includeContact") === "1";

  let markdown: string, generatedAt: Date;
  try {
    ({ markdown, generatedAt } = await generateStudentDataReport({ includeContact }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Report generation failed" }, { status: 500 });
  }

  const filename = studentDataReportFilename(generatedAt);

  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
