import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getSnapshot } from "@/lib/seo-intel/sync";
import { listHistory } from "@/lib/seo-intel/history";

/**
 * CSV download of the stored SEO Intelligence reports (no Google request).
 * Any admin with SEO_INTEL_VIEW. Cells that a spreadsheet would treat as a
 * formula (= + - @, tab, CR) are prefixed with ' — search queries are
 * user-typed text from Google.
 */
const REPORTS = ["queries", "pages", "landing-pages", "channels", "history"] as const;
type Report = (typeof REPORTS)[number];

function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.SEO_INTEL_VIEW);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }
  const report = request.nextUrl.searchParams.get("report") as Report | null;
  if (!report || !REPORTS.includes(report)) return NextResponse.json({ error: "Unknown report." }, { status: 400 });

  const snap = await getSnapshot();
  let rows: unknown[][];
  if (report === "queries" || report === "pages") {
    const list = (report === "queries" ? snap.gsc?.topQueries : snap.gsc?.topPages) ?? [];
    rows = [[report === "queries" ? "query" : "page", "clicks", "impressions", "ctr", "position"], ...list.map((r) => [r.key, r.clicks, r.impressions, r.ctr.toFixed(4), r.position.toFixed(2)])];
  } else if (report === "landing-pages" || report === "channels") {
    const list = (report === "channels" ? snap.ga4?.channels : snap.ga4?.landingPages) ?? [];
    rows = [[report === "channels" ? "channel" : "landing_page", "sessions", "active_users"], ...list.map((r) => [r.key, r.sessions, r.activeUsers])];
  } else {
    const hist = await listHistory(1095);
    rows = [
      ["date", "gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position", "ga4_active_users", "ga4_sessions", "ga4_page_views"],
      ...hist.map((h) => [
        h.date,
        h.gsc?.totals.clicks ?? "",
        h.gsc?.totals.impressions ?? "",
        h.gsc ? h.gsc.totals.ctr.toFixed(4) : "",
        h.gsc ? h.gsc.totals.position.toFixed(2) : "",
        h.ga4?.totals.activeUsers ?? "",
        h.ga4?.totals.sessions ?? "",
        h.ga4?.totals.screenPageViews ?? "",
      ]),
    ];
  }
  const date = (snap.lastSync?.at ?? new Date().toISOString()).slice(0, 10);
  return new NextResponse(csv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="seo-intel-${report}-${date}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
