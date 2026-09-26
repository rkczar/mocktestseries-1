"use client";

import { Card, CardContent } from "@/components/ui/card";
import { UniversalTestSetup, type TestSetupExam } from "@/components/student/universal-test-setup";
import { startSubjectTestAction, countAvailableQuestionsAction } from "../actions";

/**
 * Subject Test = the same UniversalTestSetup as Custom Module, with the exam
 * fixed by this page and a subject required. Time mode and answer mode are
 * frozen onto the SUBJECT_TEST attempt, which runs in the universal player.
 */
export function SubjectTestBuilder({
  exam,
  initialSubjectId,
}: {
  exam: TestSetupExam & { instructions: string | null };
  initialSubjectId?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <UniversalTestSetup
        exams={[{ id: exam.id, name: exam.name }]}
        initialExam={exam}
        examLocked
        subjectRequired
        initialSubjectId={initialSubjectId}
        action={startSubjectTestAction}
        countAction={countAvailableQuestionsAction}
        submitLabel="Start Subject Test"
        pendingLabel="Building test…"
        footnote="No negative marking for subject tests. If you already have a subject test in progress for this subject, starting again resumes that attempt with your exact previous set of questions."
      />
      {exam.instructions ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm font-medium text-[var(--color-foreground)]">Instructions</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{exam.instructions}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
