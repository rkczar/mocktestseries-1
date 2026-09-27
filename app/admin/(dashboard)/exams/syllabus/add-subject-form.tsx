"use client";

import { SubjectForm } from "../subjects/subject-form";

/** Syllabus "Add Subject": the canonical Create New Subject form, fixed to this exam (duplicate names offer "Use Existing"). */
export function AddSubjectForm({ examId }: { examId: string }) {
  return <SubjectForm fixedExamId={examId} />;
}
