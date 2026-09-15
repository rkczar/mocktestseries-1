import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { getSubjectTestSetup } from "@/lib/student-data";
import { SubjectTestBuilder } from "./builder";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Build Subject Test — Mock Test Series.in" };

export default async function SubjectTestExamPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  await requireStudent();
  const setup = await getSubjectTestSetup(examId);
  if (!setup) notFound();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/subject-test" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{setup.exam.name}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Build a practice test from the question bank.</p>
      </div>

      <SubjectTestBuilder
        exam={{
          id: setup.exam.id,
          name: setup.exam.name,
          instructions: setup.exam.instructions,
          durationMinutes: setup.exam.durationMinutes,
        }}
        subjects={setup.exam.subjects}
        years={setup.years}
      />
    </div>
  );
}