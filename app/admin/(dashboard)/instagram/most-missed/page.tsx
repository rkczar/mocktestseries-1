import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { Input } from "@/components/ui/input";
import { EditorHost, OpenInEditor } from "@/components/admin/instagram/editor-host";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import {
  MM_MIN_PCT_CHOICES,
  MM_MIN_WRONG_CHOICES,
  MM_SHOW,
  getMostMissed,
  mostMissedFilterOptions,
  mostMissedQuery,
  parseMostMissedFilters,
} from "@/lib/instagram/most-missed";

export const metadata = { title: "Most Missed MCQ — Instagram — Mock Test Series.in Admin" };

const RANGES = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 Days" },
  { key: "custom", label: "Custom range" },
];

/**
 * Admin → Instagram → Most Missed MCQ. The ranking and every number come from
 * Admin → Analytics → Question Insights (lib/question-insights.ts) — final
 * answers of submitted attempts, Asia/Kolkata calendar days. Only aggregate
 * counts are shown; no student is ever identified.
 */
export default async function MostMissedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseMostMissedFilters(await searchParams);
  const [result, options] = await Promise.all([getMostMissed(filters), mostMissedFilterOptions(filters)]);
  const query = mostMissedQuery(filters);
  const f = filters.insight;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Most Missed MCQ</CardTitle>
          <CardDescription>Questions answered wrong most often, from Question Insights. Dates are India time (IST).</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="mm-filters">
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Period
              <SelectNative name="range" defaultValue={f.range}>
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              From (custom)
              <Input type="date" name="from" defaultValue={f.from ?? ""} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              To (custom)
              <Input type="date" name="to" defaultValue={f.to ?? ""} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Exam
              <SelectNative name="examId" defaultValue={f.examId ?? ""}>
                <option value="">All exams</option>
                {options.exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Subject
              <SelectNative name="subjectId" defaultValue={f.subjectId ?? ""}>
                <option value="">All subjects</option>
                {options.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Minimum valid attempts
              <SelectNative name="min" defaultValue={String(f.min)}>
                {options.minAttemptChoices.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Minimum wrong answers
              <SelectNative name="minWrong" defaultValue={String(filters.minWrong)}>
                {MM_MIN_WRONG_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Any" : n}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Minimum wrong %
              <SelectNative name="minPct" defaultValue={String(filters.minPct)}>
                {MM_MIN_PCT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Any" : `${n}%`}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Rank by
              <SelectNative name="sort" defaultValue={f.sort}>
                <option value="wrong">Wrong-answer count</option>
                <option value="wrongPct">Wrong-answer percentage</option>
              </SelectNative>
            </label>
            <div className="flex items-end">
              <Button type="submit" data-testid="mm-apply">
                Show questions
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{`Period: ${result.range.label}`}</CardTitle>
          <CardDescription>
            {result.range.error
              ? result.range.error
              : `${result.rows.length} shown (top ${MM_SHOW}) of ${result.scanned}${result.truncated ? "+" : ""} questions with at least ${f.min} valid attempt${f.min === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <EditorHost>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="mm-table">
                <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
                  <tr>
                    <th className="py-2 pr-3">Rank</th>
                    <th className="py-2 pr-3">Code</th>
                    <th className="py-2 pr-3">Question</th>
                    <th className="py-2 pr-3 text-right">Attempts</th>
                    <th className="py-2 pr-3 text-right">Wrong</th>
                    <th className="py-2 pr-3 text-right">Wrong %</th>
                    <th className="py-2 pr-3">Checks</th>
                    <th className="py-2 pr-3">Instagram</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-row={r.code}>
                      <td className="py-2 pr-3 tabular-nums">{r.rank}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{r.code}</td>
                      <td className="max-w-md py-2 pr-3">
                        <OpenInEditor target={{ questionId: r.id, code: r.code, preview: r.preview, series: "MOST_MISSED", filterQuery: query }} className="hover:underline" testId="open-question">
                          {r.preview}
                        </OpenInEditor>
                        <div className="text-xs text-[var(--color-muted-foreground)]">{`${r.examName} · ${r.subject}${r.topic ? ` / ${r.topic}` : ""}`}</div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.attempts}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.wrong}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{`${r.wrongPct.toFixed(1)}%`}</td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {r.keyIssue ? <Badge variant="error">Answer key issue</Badge> : null}
                          {r.keyChanged ? <Badge variant="warning">Key changed in period</Badge> : null}
                          {r.hasImage ? <Badge variant="info">Has image</Badge> : null}
                          {r.reviewRequired ? <Badge variant="warning">QB review required</Badge> : null}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <InstagramStatusBadge status={r.instagram.status} posted={r.instagram.posted} />
                      </td>
                    </tr>
                  ))}
                  {result.rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-[var(--color-muted-foreground)]" data-testid="mm-empty">
                        No questions match these filters in this period.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </EditorHost>
        </CardContent>
      </Card>
    </div>
  );
}
