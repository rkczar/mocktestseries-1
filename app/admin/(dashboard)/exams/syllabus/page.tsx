import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ExamPicker } from "./exam-picker";
import { SyllabusEnabledToggle } from "./syllabus-enabled-toggle";
import { DescriptionForm } from "./description-form";
import { AddSubjectForm } from "./add-subject-form";
import { SubjectPanel } from "./subject-panel";
import { updateExamSyllabusDescriptionAction } from "./actions";

export const metadata = { title: "Syllabus — Mock Test Series.in Admin" };

export default async function SyllabusPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;

  const exams = await prisma.exam.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true } });

  const selectedExam = examId
    ? await prisma.exam.findUnique({
        where: { id: examId },
        include: {
          subjects: {
            orderBy: [{ order: "asc" }, { name: "asc" }],
            include: {
              topics: {
                orderBy: [{ order: "asc" }, { name: "asc" }],
                include: { subTopics: { orderBy: { order: "asc" } }, _count: { select: { questions: true } } },
              },
            },
          },
        },
      })
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Syllabus</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Manage the public syllabus for an exam — Subjects and Chapters/Topics are the same Exam → Subject → Topic →
          SubTopic taxonomy used by the Question Bank and bulk import, so anything added here (or renamed/removed)
          shows up there automatically, and vice versa.
        </p>
      </div>

      <ExamPicker exams={exams} selectedExamId={examId} />

      {!examId ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
            Select an exam above to manage its syllabus.
          </CardContent>
        </Card>
      ) : !selectedExam ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">Exam not found.</CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle>{selectedExam.name}</CardTitle>
                <CardDescription>{selectedExam.subjects.length} subject{selectedExam.subjects.length === 1 ? "" : "s"}</CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <SyllabusEnabledToggle examId={selectedExam.id} enabled={selectedExam.syllabusEnabled} />
                <Link
                  href={`/student/exams/${selectedExam.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  Preview public page →
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <DescriptionForm
                action={updateExamSyllabusDescriptionAction}
                idField="examId"
                idValue={selectedExam.id}
                defaultValue={selectedExam.syllabusDescription}
                placeholder="Overview of this exam's syllabus (shown above the subject tiles)…"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add Subject</CardTitle>
            </CardHeader>
            <CardContent>
              <AddSubjectForm examId={selectedExam.id} />
            </CardContent>
          </Card>

          {selectedExam.subjects.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                No subjects yet — add one above.
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              {selectedExam.subjects.map((subject, i) => (
                <SubjectPanel
                  key={subject.id}
                  examId={selectedExam.id}
                  subject={subject}
                  isFirst={i === 0}
                  isLast={i === selectedExam.subjects.length - 1}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
