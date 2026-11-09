import Link from "next/link";
import { requireTeacherPage } from "@/lib/teacher/page";
import { listTeacherQuestions, parseQuestionListFilters, questionListQuery, teacherExams, teacherQuestionFilterOptions } from "@/lib/teacher/queries";
import { Card, CardContent } from "@/components/ui/card";
import { Pager, QuestionStatusBadge } from "@/components/teacher/ui";
import { QuestionPreviewBody } from "@/components/content/question-preview-body";

export const metadata = { title: "Questions — Teacher Portal" };

const sel = "rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1";

/**
 * Teacher Portal → Questions: the teacher's exams only, every row expandable
 * to the full question (shared QuestionPreviewBody — same renderer as Admin
 * preview), "Expand all", and Edit links that come back to this list position.
 */
export default async function TeacherQuestions({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const scope = await requireTeacherPage();
  const sp = await searchParams;
  const f = parseQuestionListFilters(sp);
  const expandAll = sp.expand === "all";
  const [exams, list, opts] = await Promise.all([teacherExams(scope), listTeacherQuestions(scope, f), teacherQuestionFilterOptions(scope)]);
  const from = questionListQuery(f);
  const examTree = opts.tree.filter((e) => !f.examId || e.id === f.examId);
  const subjects = examTree.flatMap((e) => e.subjects);
  const topics = subjects.filter((s) => !f.subjectId || s.id === f.subjectId).flatMap((s) => s.topics);
  const subTopics = topics.filter((t) => !f.topicId || t.id === f.topicId).flatMap((t) => t.subTopics);
  const papers = opts.papers.filter((p) => !f.examId || p.examId === f.examId);
  const uniq = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Questions</h1>
        {exams.length ? <Link href={`/teacher/questions/new${f.examId ? `?exam=${f.examId}` : ""}`} className="rounded-[var(--radius-button)] bg-[var(--color-action-fill)] px-3 py-2 text-sm text-[var(--color-action-ink)]">Add question</Link> : null}
      </div>
      <form className="flex flex-wrap gap-2 text-sm" action="/teacher/questions" data-testid="question-filters">
        <select name="exam" defaultValue={f.examId ?? ""} className={sel} aria-label="Exam">
          <option value="">All my exams</option>
          {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select name="subject" defaultValue={f.subjectId ?? ""} className={sel} aria-label="Subject">
          <option value="">Any subject</option>
          {uniq(subjects).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select name="topic" defaultValue={f.topicId ?? ""} className={sel} aria-label="Topic">
          <option value="">Any topic</option>
          {uniq(topics).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select name="subtopic" defaultValue={f.subTopicId ?? ""} className={sel} aria-label="Sub-topic">
          <option value="">Any sub-topic</option>
          {uniq(subTopics).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select name="paper" defaultValue={f.paperId ?? ""} className={sel} aria-label="PYQ paper">
          <option value="">Any paper</option>
          {papers.map((p) => <option key={p.id} value={p.id}>{p.year} — {p.title}</option>)}
        </select>
        <select name="status" defaultValue={f.status ?? ""} className={sel} aria-label="Status">
          <option value="">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <input name="q" defaultValue={f.q ?? ""} placeholder="Search code or text" className={sel} aria-label="Search" />
        <button type="submit" className="rounded border border-[var(--color-border)] px-3 py-1">Filter</button>
      </form>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[var(--color-muted-foreground)]">{list.total} question(s)</span>
        {expandAll ? <Link className="underline" href={`/teacher/questions?${from}`}>Collapse all</Link> : <Link className="underline" href={`/teacher/questions?${questionListQuery(f, { expand: true })}`}>Expand all</Link>}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 py-3" data-testid="question-list">
          {list.rows.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No questions found.</p> : null}
          {list.rows.map((q) => {
            const editable = !q.retiredAt && q.status !== "ARCHIVED";
            return (
              <details key={q.id} open={expandAll} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-question={q.id}>
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs">{q.code}</span>
                    <QuestionStatusBadge status={q.status} retired={!!q.retiredAt} />
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {q.exam.name} · {q.subject.name}
                      {q.topic ? ` › ${q.topic.name}` : ""}
                      {q.subTopic ? ` › ${q.subTopic.name}` : ""}
                      {q.previousYearPaper ? ` · PYQ ${q.previousYearPaper.year}` : ""}
                    </span>
                    <span className="ml-auto text-xs text-[var(--color-primary)]">Expand / collapse</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm">{q.text}</p>
                </summary>
                <div className="mt-3 flex flex-col gap-3 border-t border-[var(--color-border)] pt-3" data-testid="full-preview">
                  <QuestionPreviewBody q={q} />
                  <div className="flex gap-3 text-sm">
                    {editable ? <Link className="underline" href={`/teacher/questions/${q.id}/edit?from=${encodeURIComponent(from)}`}>{q.status === "PUBLISHED" ? "Edit (revision)" : "Edit"}</Link> : null}
                    <Link className="underline" href={`/teacher/questions/${q.id}?from=${encodeURIComponent(from)}`}>Details, usage and requests</Link>
                  </div>
                </div>
              </details>
            );
          })}
        </CardContent>
      </Card>
      <Pager page={f.page} pages={list.pages} href={(p) => `/teacher/questions?${questionListQuery(f, { page: p, expand: expandAll })}`} />
    </>
  );
}
