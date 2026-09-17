import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { getSubjectTestSetup, getActiveExamsCatalog } from "@/lib/student-data";
import { BackButton } from "@/components/student/back-button";
import { CustomModuleBuilder } from "./custom-module-builder";

export const metadata = { title: "Build Your Own Module — Mock Test Series.in" };

export default async function CustomModuleBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const student = await requireStudent();
  const { examId } = await searchParams;

  const exams = await getActiveExamsCatalog();
  const setup = examId ? await getSubjectTestSetup(examId) : null;
  if (examId && !setup) notFound();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href={examId ? `/student/exams/${examId}` : "/student/custom-module"} />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Build Your Own Module</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pick an exam and filters, choose how many questions and how long, and we&apos;ll build a fixed practice set
          just for you.
        </p>
      </div>

      <CustomModuleBuilder
        studentId={student.id}
        exams={exams.map((e) => ({ id: e.id, name: e.name }))}
        initialExam={
          setup
            ? {
                id: setup.exam.id,
                name: setup.exam.name,
                subjects: setup.exam.subjects,
                years: setup.years,
              }
            : null
        }
      />
    </div>
  );
}
