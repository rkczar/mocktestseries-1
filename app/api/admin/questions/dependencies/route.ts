import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/rbac";
import { getPaperDependencySummary, paperDependenciesCsv } from "@/lib/question-dependencies";

/** CSV of a paper's question dependencies (any signed-in admin, same as the paper page). Read-only. */
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const paperId = request.nextUrl.searchParams.get("paperId");
  if (!paperId) return NextResponse.json({ error: "paperId is required" }, { status: 400 });
  const summary = await getPaperDependencySummary(paperId);
  if (!summary) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  const name = `${summary.paper.title}-${summary.paper.year}-dependencies`.replace(/[^A-Za-z0-9-]+/g, "-");
  return new NextResponse(paperDependenciesCsv(summary), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
