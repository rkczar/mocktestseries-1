import Link from "next/link";
import { notFound } from "next/navigation";
import { getPaperDependencySummary } from "@/lib/question-dependencies";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KIND_LABEL } from "@/components/admin/question-dependencies/dependency-uses-table";

export const metadata = { title: "Paper Dependencies — Mock Test Series.in Admin" };

/**
 * Admin → Previous Year Paper → Dependencies (docs/QUESTION-RETIREMENT.md):
 * every question of the paper with every test / module that reuses it and
 * every attempt that holds it. Read-only.
 */
export default async function PaperDependenciesPage({ params }: { params: Promise<{ paperId: string }> }) {
  const { paperId } = await params;
  const summary = await getPaperDependencySummary(paperId);
  if (!summary) notFound();
  const t = summary.totals;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link href={`/admin/exams/previous-year-papers/${paperId}`} className="text-xs text-[var(--color-primary)] hover:underline">
            ← {summary.paper.title}
          </Link>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Dependencies</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {summary.paper.examName} · {summary.paper.year}
            {summary.paper.paperCode ? ` · Paper ${summary.paper.paperCode}` : ""} · paper id <span className="font-mono">{summary.paper.id}</span>
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/admin/questions/dependencies?paperId=${paperId}`}>Download CSV</a>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="Questions" value={t.questions} />
        <Tile label="Published" value={t.published} />
        <Tile label="Retired" value={t.retired} />
        <Tile label="Archived (not retired)" value={t.archived} />
        <Tile label="Reused elsewhere" value={t.reused} />
        <Tile label="Mock Tests" value={t.mockTests} />
        <Tile label="Admin modules" value={t.adminModules} />
        <Tile label="Student modules" value={t.studentModules} />
        <Tile label="Paper attempts (submitted / in progress / reset)" value={`${t.paperAttempts.submitted} / ${t.paperAttempts.inProgress} / ${t.paperAttempts.invalidated}`} />
        <Tile label="Active sessions holding its questions" value={t.activeSessions} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>Paper order. Positions are inside each test or module (Q-number there), separate from the paper number.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-3">No.</th>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Used in (position)</th>
                <th className="py-2 pr-3">Attempts</th>
                <th className="py-2 pr-3">Sessions</th>
                <th className="py-2 pr-3">Variants · bookmarks · reports</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {summary.questions.map((q) => (
                <tr key={q.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{q.paperQuestionNumber ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {q.code}
                    <div className="text-[10px] text-[var(--color-muted-foreground)]">{q.id}</div>
                  </td>
                  <td className="py-2 pr-3">
                    {q.retiredAt ? <Badge variant="error">RETIRED</Badge> : <Badge variant={q.status === "PUBLISHED" ? "success" : "warning"}>{q.status}</Badge>}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {q.uses.length === 0 ? (
                      <span className="text-[var(--color-muted-foreground)]">—</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer">
                          {q.mockTests} mock · {q.adminModules} admin module · {q.studentModules} student module
                          {q.grandOrLive ? ` · ${q.grandOrLive} grand/live` : ""}
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {q.uses.map((u) => (
                            <li key={`${u.kind}:${u.id}`}>
                              {KIND_LABEL[u.kind]}
                              {u.studentOwned ? " (student)" : ""} “{u.title}” · {u.status} · Q{u.position}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {q.attempts.submitted} submitted · {q.attempts.inProgress} in progress
                    {q.attempts.invalidated ? ` · ${q.attempts.invalidated} reset` : ""}
                  </td>
                  <td className="py-2 pr-3 text-xs">{q.activeSessions}</td>
                  <td className="py-2 pr-3 text-xs">
                    {q.aiVariants} · {q.bookmarks} · {q.reports}
                  </td>
                  <td className="py-2 pr-3">
                    <Button asChild size="compact" variant="outline">
                      <Link href={`/admin/questions/${q.id}/replace`}>{q.retiredAt ? "View" : "Retire / Replace"}</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</div>
      <div className="text-lg font-semibold text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}
