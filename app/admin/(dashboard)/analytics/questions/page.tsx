import Link from "next/link";
import { AnalyticsSubnav } from "@/components/admin/analytics-subnav";
import { Card, CardContent } from "@/components/ui/card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  PAGE_SIZE,
  getInsightFilterOptions,
  getInsightOverview,
  getInsightRows,
  insightFiltersToQuery,
  parseInsightFilters,
  resolveRange,
  type InsightTab,
} from "@/lib/question-insights";
import { cn } from "@/lib/utils";
import { InsightFiltersBar } from "./insight-filters";
import { InsightTable } from "./insight-table";

export const metadata = { title: "Question Insights — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const TAB_LABELS: Record<InsightTab, string> = {
  wrong: "Most Wrong",
  attempted: "Most Attempted",
  reported: "Most Reported",
  saved: "Most Saved",
  ai: "Most Asked on AI",
};

function n(value: number): string {
  return value.toLocaleString("en-IN");
}

/**
 * Admin → Analytics → Question Insights. Access matches the rest of Admin →
 * Analytics (the dashboard layout already requires an active admin session);
 * the only mutation offered here (Mark Needs Review) goes through the
 * existing QUESTIONS_MANAGE-gated bulk-actions route.
 */
export default async function QuestionInsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseInsightFilters(await searchParams);
  const range = resolveRange(filters);

  const [overview, { rows, total }, options, canManage] = await Promise.all([
    getInsightOverview(filters, range),
    getInsightRows(filters, range),
    getInsightFilterOptions(filters),
    hasPermission(PERMISSIONS.QUESTIONS_MANAGE),
  ]);

  const query = insightFiltersToQuery(filters);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const stats: { label: string; value: string }[] = [
    { label: "Questions Answered", value: n(overview.answered) },
    { label: "Unique Questions", value: n(overview.uniqueQuestions) },
    { label: "Correct", value: n(overview.correct) },
    { label: "Wrong", value: n(overview.wrong) },
    { label: "Accuracy", value: overview.accuracy === null ? "—" : `${overview.accuracy.toFixed(1)}%` },
    { label: "Students Attempting", value: n(overview.students) },
    { label: "Reports", value: n(overview.reports) },
    { label: "Reported Questions", value: n(overview.reportedQuestions) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Insights</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Questions students struggled with in a period. Pick the top questions, copy them as one block, and paste it into Telegram, WhatsApp or email
          yourself. Nothing is posted automatically.
        </p>
      </div>

      <AnalyticsSubnav active="questions" />

      <InsightFiltersBar filters={filters} options={options} rangeLabel={range.label} rangeError={range.error} />

      {/* Overview */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 py-4 sm:grid-cols-4 lg:grid-cols-8">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <p className="truncate text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{s.label}</p>
              <p className="text-lg font-semibold text-[var(--color-foreground)]">{s.value}</p>
            </div>
          ))}
          {overview.deletedQuestionAnswers > 0 && (
            <p className="col-span-full text-xs text-[var(--color-muted-foreground)]">
              {n(overview.deletedQuestionAnswers)} answer{overview.deletedQuestionAnswers === 1 ? "" : "s"} in this period belong to questions that have since been
              deleted from the Question Bank and are not counted.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Sections */}
      <nav aria-label="Question insight sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {(Object.keys(TAB_LABELS) as InsightTab[]).map((tab) => (
          <Link
            key={tab}
            href={`/admin/analytics/questions?${insightFiltersToQuery(filters, { tab, page: 1, sort: undefined })}`}
            aria-current={tab === filters.tab ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-[var(--radius-button)] px-3 py-1.5 text-sm font-medium transition-colors",
              tab === filters.tab
                ? "bg-[var(--color-action-fill)] text-[var(--color-action-ink)]"
                : "text-[var(--color-muted-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)] hover:text-[var(--color-foreground)]"
            )}
          >
            {TAB_LABELS[tab]}
          </Link>
        ))}
      </nav>

      <InsightTable
        key={insightFiltersToQuery(filters, { page: 1 })}
        tab={filters.tab}
        query={query}
        rows={rows.map((r) => ({ ...r, lastReportedAt: r.lastReportedAt?.toISOString() }))}
        total={total}
        page={filters.page}
        pageCount={pageCount}
        pageSize={PAGE_SIZE}
        minAttempts={filters.min}
        sort={filters.sort}
        canManage={canManage}
        exportHref={`/api/admin/analytics/question-insights/export?${insightFiltersToQuery(filters, { page: 1 })}`}
        prevHref={filters.page > 1 ? `/admin/analytics/questions?${insightFiltersToQuery(filters, { page: filters.page - 1 })}` : null}
        nextHref={filters.page < pageCount ? `/admin/analytics/questions?${insightFiltersToQuery(filters, { page: filters.page + 1 })}` : null}
      />
    </div>
  );
}
