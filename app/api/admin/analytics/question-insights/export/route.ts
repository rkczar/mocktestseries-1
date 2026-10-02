import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/rbac";
import { getInsightExportRows, parseInsightFilters, resolveRange } from "@/lib/question-insights";
import { toIstDateString } from "@/lib/ist-time";

export const dynamic = "force-dynamic";

/** Neutralises spreadsheet formula injection (=, +, -, @, tab, CR) and quotes every cell. */
function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * CSV of the current Question Insights view (same filters/tab/sort as the
 * page, up to 5,000 rows). Aggregates only — no student data. Same access
 * rule as the page: any signed-in, active admin.
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const filters = parseInsightFilters(Object.fromEntries(request.nextUrl.searchParams.entries()));
  const range = resolveRange(filters);
  const rows = await getInsightExportRows(filters, range);

  const header = ["Question Code", "Exam", "Subject", "Topic", "Sub-topic", "Status", "Attempts", "Correct", "Wrong", "Wrong %", "Reports", "Saves", "Needs Review", "Data Issue"];
  if (filters.tab === "ai") header.push("Ask AI Opens", "Ask AI Students");
  const lines = rows.map((r) => {
    const cells: (string | number | null)[] = [
      r.code,
      r.examName,
      r.subjectName,
      r.topicName,
      r.subTopicName,
      r.status,
      r.attempts,
      r.correct,
      r.wrong,
      r.wrongPct === null ? "" : r.wrongPct.toFixed(1),
      r.reports,
      r.saves,
      r.reviewRequired ? "Yes" : "",
      r.keyIssue ?? (r.keyChanged ? "ANSWER_KEY_CHANGED" : ""),
    ];
    if (filters.tab === "ai") cells.push(r.aiViews ?? 0, r.aiStudents ?? 0);
    return cells.map(csvCell).join(",");
  });
  const csv = [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
  const stamp = toIstDateString(new Date());

  return new NextResponse(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="question-insights-${filters.tab}-${filters.range}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
