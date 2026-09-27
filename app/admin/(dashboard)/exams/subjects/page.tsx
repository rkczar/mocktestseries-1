import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { examQuestionCounts, getMasterTaxonomy } from "@/lib/exam-taxonomy";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ExamFilterSelect } from "@/components/admin/exam-filter-select";
import { SubjectForm } from "./subject-form";
import { SubjectDeleteButton } from "./subject-delete-button";
import { SubjectEditDialog } from "./subject-edit-dialog";
import { RemoveFromExamButton } from "./remove-from-exam-button";
import { TaxonomyLinker } from "./taxonomy-linker";

export const metadata = { title: "Subjects — Mock Test Series.in Admin" };

/**
 * Subjects are canonical master records shared across exams. One exam's
 * view lists the subjects it LINKS; "All Exams" lists every master record
 * with the exams using it. Remove from Exam unlinks; master delete is only
 * offered in the overview and is refused while anything references it.
 */
export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId: requestedExamId } = await searchParams;
  const exams = await prisma.exam.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  const examName = new Map(exams.map((e) => [e.id, e.name]));

  // Exam-wise by default (Section 10): an explicit examId wins, "" means the
  // admin chose "All Exams", and no param at all defaults to the first Exam.
  const showAll = requestedExamId === "";
  const examId = requestedExamId !== undefined ? requestedExamId : (exams[0]?.id ?? "");

  const [master, links, counts] = await Promise.all([
    getMasterTaxonomy(prisma),
    examId && !showAll
      ? prisma.examSubject.findMany({ where: { examId, isActive: true }, orderBy: [{ displayOrder: "asc" }, { subject: { name: "asc" } }] })
      : Promise.resolve([]),
    examId && !showAll ? examQuestionCounts(prisma, examId) : Promise.resolve(null),
  ]);
  const masterById = new Map(master.map((s) => [s.id, s]));
  const questionTotals = showAll
    ? new Map((await prisma.question.groupBy({ by: ["subjectId"], _count: { _all: true } })).map((r) => [r.subjectId, r._count._all]))
    : null;

  const rows = showAll
    ? master.map((s) => ({ subject: s, order: 0 }))
    : links.flatMap((l) => (masterById.has(l.subjectId) ? [{ subject: masterById.get(l.subjectId)!, order: l.displayOrder }] : []));
  const currentExamName = examName.get(examId) ?? "Exam";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Subjects</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Subjects are shared master records: create one once and link it to every exam that uses it. They are the top level of
          the categorization used by the Question Bank, Bulk Import, Custom Modules, Subject Tests and exam pages.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exam</CardTitle>
          <CardDescription>Subjects are managed one Exam at a time. Choose &quot;All Exams&quot; for the master overview.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label>Select Exam</Label>
            <ExamFilterSelect options={exams} paramName="examId" value={examId} allowAll allLabel="All Exams (master overview)" />
          </div>
        </CardContent>
      </Card>

      {!showAll && examId ? (
        <Card>
          <CardHeader>
            <CardTitle>Add Subjects to {currentExamName}</CardTitle>
            <CardDescription>Reuse existing master subjects (no copies), or create a new one if it truly doesn&apos;t exist yet.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <TaxonomyLinker mode="existing" examId={examId} examName={currentExamName} exams={exams} master={master} />
              <TaxonomyLinker mode="exam" examId={examId} examName={currentExamName} exams={exams} master={master} />
            </div>
            <SubjectForm exams={exams} defaultExamId={examId} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{showAll ? "All Master Subjects" : `${currentExamName}'s Subjects`}</CardTitle>
          <CardDescription>
            {rows.length} subject{rows.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              {showAll ? "No subjects yet." : "No subjects linked yet — add existing ones or reuse another exam's taxonomy above."}
            </p>
          ) : (
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">{showAll ? "Used by Exams" : "Also used by"}</th>
                  <th className="py-2 pr-4">Topics</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ subject: s, order }) => {
                  const others = s.examIds.filter((id) => showAll || id !== examId).map((id) => examName.get(id) ?? "?");
                  const linkedTopics = showAll ? s.topics.length : s.topics.filter((t) => t.examIds.includes(examId)).length;
                  return (
                    <tr key={s.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{s.name}</td>
                      <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{others.length ? others.join(", ") : "—"}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        <Link
                          href={`/admin/exams?tab=subjects&examId=${showAll ? (s.examIds[0] ?? "") : examId}&subjectId=${s.id}`}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          {showAll ? linkedTopics : `${linkedTopics} of ${s.topics.length}`} — View Topics
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        {showAll ? (questionTotals?.get(s.id) ?? 0) : (counts?.subject.get(s.id) ?? 0)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center justify-end gap-1">
                          <SubjectEditDialog id={s.id} name={s.name} order={order} examId={showAll ? undefined : examId} />
                          {showAll ? (
                            <SubjectDeleteButton subjectId={s.id} />
                          ) : (
                            <RemoveFromExamButton kind="subject" examId={examId} id={s.id} label={s.name} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
