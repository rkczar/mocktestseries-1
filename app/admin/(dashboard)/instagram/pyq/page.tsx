import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditorHost, OpenInEditor } from "@/components/admin/instagram/editor-host";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import { getPaperDetail, listPapersByYear, listPyqExams, type ContentReview } from "@/lib/instagram/queries";
import { cn } from "@/lib/utils";

export const metadata = { title: "PYQ Series — Instagram — Mock Test Series.in Admin" };

const ID = /^[a-z0-9]{10,40}$/i;
const IG_FILTERS = [
  { key: "", label: "All" },
  { key: "NOT_CREATED", label: "Not created" },
  { key: "DRAFT", label: "Draft" },
  { key: "READY", label: "Ready" },
  { key: "PUBLISHED", label: "Posted" },
] as const;

const FLAG_LABEL: Record<ContentReview, { label: string; variant: "warning" | "error" | "info" | "neutral" }> = {
  CHECK_TEXT: { label: "Check text (may be cut off)", variant: "warning" },
  ANSWER_KEY: { label: "Answer key issue", variant: "error" },
  HAS_IMAGE: { label: "Has image", variant: "info" },
  QB_REVIEW: { label: "QB review required", variant: "warning" },
  OK: { label: "OK", variant: "neutral" },
};

const AI_LABEL = { NONE: "No AI explanation", UNREVIEWED: "AI explanation (unreviewed)", REVIEWED: "AI explanation (reviewed)", STALE: "AI explanation (stale)" } as const;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Admin → Instagram → PYQ Series: Exam → Year → Paper → Question. Questions
 * are listed in the paper's stored order (the order the PYQ test serves),
 * which is NOT assumed to be the printed question number.
 */
export default async function PyqSeriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const exams = await listPyqExams();
  const examId = ID.test(one(sp.examId) ?? "") ? one(sp.examId)! : exams[0]?.id;
  const paperId = ID.test(one(sp.paperId) ?? "") ? one(sp.paperId)! : undefined;
  const yearParam = Number(one(sp.year));
  const ig = IG_FILTERS.find((f) => f.key === (one(sp.ig) ?? ""))?.key ?? "";

  const [years, paper] = await Promise.all([examId ? listPapersByYear(examId) : Promise.resolve([]), paperId ? getPaperDetail(paperId) : Promise.resolve(null)]);
  const year = paper?.year ?? (years.some((y) => y.year === yearParam) ? yearParam : years[0]?.year);
  const papersOfYear = years.find((y) => y.year === year)?.papers ?? [];
  const href = (p: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    const merged = { examId, year, paperId, ig: ig || undefined, ...p };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") q.set(k, String(v));
    return `/admin/instagram/pyq?${q.toString()}`;
  };
  const rows = paper ? paper.questions.filter((q) => !ig || (ig === "PUBLISHED" ? q.instagram.posted : q.instagram.status === ig)) : [];

  if (exams.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">No exam has previous year papers yet.</CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Step 1: exam */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>1. Exam</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 px-5 pb-5" data-testid="exam-list">
          {exams.map((e) => (
            <Link
              key={e.id}
              href={`/admin/instagram/pyq?examId=${e.id}`}
              className={cn("rounded-[var(--radius-button)] border px-3 py-1.5 text-sm", e.id === examId ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "border-[var(--color-border)]")}
            >
              {e.name} <span className="text-xs text-[var(--color-muted-foreground)]">{`· ${e.paperCount} paper${e.paperCount === 1 ? "" : "s"}`}</span>
            </Link>
          ))}
        </CardContent>
      </Card>

      {/* Step 2 + 3: year, paper */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>2. Year and 3. Paper</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-5 pb-5">
          <div className="flex flex-wrap gap-2" data-testid="year-list">
            {years.map((y) => (
              <Link
                key={y.year}
                href={href({ year: y.year, paperId: undefined })}
                className={cn("rounded-[var(--radius-button)] border px-3 py-1 text-sm tabular-nums", y.year === year ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "border-[var(--color-border)]")}
              >
                {y.year}
              </Link>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="paper-list">
            {papersOfYear.map((p) => (
              <Link
                key={p.id}
                href={href({ paperId: p.id, ig: undefined })}
                className={cn("flex flex-col gap-1 rounded-[var(--radius-card)] border p-3 text-sm", p.id === paperId ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-[var(--color-border)] hover:bg-[var(--color-surface)]")}
              >
                <span className="font-medium">{p.title}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {`${p.questionCount} questions${p.paperCode ? ` · ${p.paperCode}` : ""}${p.isActive ? "" : " · inactive"}`}
                </span>
                <span className="flex gap-1">
                  {p.posted ? <Badge variant="success">{`${p.posted} posted`}</Badge> : null}
                  {p.inProgress ? <Badge variant="info">{`${p.inProgress} in progress`}</Badge> : null}
                </span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Step 4: question */}
      {paper ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{`4. Question — ${paper.title}`}</CardTitle>
            <CardDescription>
              Listed in the stored order (the order the PYQ test uses). This is not necessarily the printed question number — enter and verify that inside the editor. Click a question to open its carousel.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-5 pb-5">
            <div className="flex flex-wrap gap-2" data-testid="ig-filter">
              {IG_FILTERS.map((f) => (
                <Link
                  key={f.key}
                  href={href({ ig: f.key || undefined })}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs", f.key === ig ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted-foreground)]")}
                >
                  {f.label}
                </Link>
              ))}
            </div>
            <EditorHost>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="question-table">
                  <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
                    <tr>
                      <th className="py-2 pr-3">#</th>
                      <th className="py-2 pr-3">Code</th>
                      <th className="py-2 pr-3">Subject / Topic</th>
                      <th className="py-2 pr-3">Question</th>
                      <th className="py-2 pr-3">Content review</th>
                      <th className="py-2 pr-3">Instagram</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((q) => (
                      <tr key={q.id} className="border-t border-[var(--color-border)] align-top" data-row={q.code}>
                        <td className="py-2 pr-3 tabular-nums text-[var(--color-muted-foreground)]" title="Stored position — not the printed number">
                          {q.position}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{q.code}</td>
                        <td className="py-2 pr-3">
                          <div>{q.subject}</div>
                          {q.topic ? <div className="text-xs text-[var(--color-muted-foreground)]">{q.topic}</div> : null}
                        </td>
                        <td className="max-w-md py-2 pr-3">
                          <OpenInEditor target={{ questionId: q.id, code: q.code, preview: q.preview, series: "PYQ" }} className="hover:underline" testId="open-question">
                            {q.preview}
                          </OpenInEditor>
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {q.flags.length ? q.flags.map((f) => <Badge key={f} variant={FLAG_LABEL[f].variant}>{FLAG_LABEL[f].label}</Badge>) : <Badge variant="success">Looks complete</Badge>}
                            <Badge variant={q.aiExplanation === "REVIEWED" ? "success" : "neutral"}>{AI_LABEL[q.aiExplanation]}</Badge>
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <InstagramStatusBadge status={q.instagram.status} posted={q.instagram.posted} />
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-[var(--color-muted-foreground)]">
                          No questions match this filter.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </EditorHost>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
