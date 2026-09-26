"use client";

import { UniversalTestSetup, type TestSetupExam } from "@/components/student/universal-test-setup";
import { createCustomModuleAction, countCustomModuleQuestionsAction, getExamSetupAction } from "./actions";

/** Custom Module = UniversalTestSetup with a free exam/subject choice; the attempt runs in the universal player. */
export function CustomModuleBuilder({
  exams,
  initialExam,
}: {
  studentId: string;
  exams: { id: string; name: string }[];
  initialExam: TestSetupExam | null;
}) {
  return (
    <UniversalTestSetup
      exams={exams}
      initialExam={initialExam}
      action={createCustomModuleAction}
      countAction={countCustomModuleQuestionsAction}
      setupAction={getExamSetupAction}
      submitLabel="Create & Start"
      pendingLabel="Building module…"
      footnote="This module is private to you. The question set is fixed the moment you create it — refreshing or resuming never generates a new set."
    />
  );
}
