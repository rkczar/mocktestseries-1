import type { Metadata } from "next";

import { createExamAction } from "../actions";
import { ExamForm } from "../ExamForm";

export const metadata: Metadata = { title: "New Exam · Admin" };

export default function NewExamPage() {
  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New exam</h1>
      <div className="mt-6">
        <ExamForm action={createExamAction} submitLabel="Create exam" />
      </div>
    </div>
  );
}
