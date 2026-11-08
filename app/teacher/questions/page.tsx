import Link from "next/link";
import { requireTeacherPage } from "@/lib/teacher/page";
import { listTeacherQuestions, teacherExams } from "@/lib/teacher/queries";
import { Card, CardContent } from "@/components/ui/card";
import { Pager, QuestionStatusBadge } from "@/components/teacher/ui";

export const metadata = { title: "Questions — Teacher Portal" };

export default async function TeacherQuestions({ searchParams }: { searchParams: Promise<{ exam?: string; status?: string; q?: string; page?: string }> }) {
  const scope = await requireTeacherPage();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const [exams, list] = await Promise.all([teacherExams(scope), listTeacherQuestions(scope, { examId: sp.exam, status: sp.status, q: sp.q?.trim().slice(0, 100), page })]);
  const qs = (p: number) => `/teacher/questions?${new URLSearchParams({ ...(sp.exam ? { exam: sp.exam } : {}), ...(sp.status ? { status: sp.status } : {}), ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Questions</h1>
        {exams.length ? <Link href={`/teacher/questions/new${sp.exam ? `?exam=${sp.exam}` : ""}`} className="rounded-[var(--radius-button)] bg-[var(--color-action-fill)] px-3 py-2 text-sm text-[var(--color-action-ink)]">Add question</Link> : null}
      </div>
      <form className="flex flex-wrap gap-2 text-sm" action="/teacher/questions">
        <select name="exam" defaultValue={sp.exam ?? ""} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
          <option value="">All my exams</option>
          {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
          <option value="">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search code or text" className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" />
        <button type="submit" className="rounded border border-[var(--color-border)] px-3 py-1">Filter</button>
      </form>
      <Card>
        <CardContent className="overflow-x-auto py-3">
          {list.rows.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No questions found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-muted-foreground)]">
                <tr><th className="py-2 pr-3">Code</th><th className="pr-3">Question</th><th className="pr-3">Exam / Subject</th><th>Status</th></tr>
              </thead>
              <tbody>
                {list.rows.map((q) => (
                  <tr key={q.id} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-3 font-mono text-xs"><Link className="underline" href={`/teacher/questions/${q.id}`}>{q.code}</Link></td>
                    <td className="max-w-md truncate pr-3">{q.text}</td>
                    <td className="pr-3 text-[var(--color-muted-foreground)]">{q.exam.name} · {q.subject.name}</td>
                    <td><QuestionStatusBadge status={q.status} retired={!!q.retiredAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-[var(--color-muted-foreground)]">{list.total} question(s)</p>
      <Pager page={page} pages={list.pages} href={qs} />
    </>
  );
}
