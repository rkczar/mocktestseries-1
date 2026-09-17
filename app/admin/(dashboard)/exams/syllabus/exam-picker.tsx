"use client";

import { useRouter } from "next/navigation";
import { SelectNative } from "@/components/ui/select-native";
import { Label } from "@/components/ui/label";

export function ExamPicker({ exams, selectedExamId }: { exams: { id: string; name: string; code: string }[]; selectedExamId?: string }) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-1.5 sm:max-w-xs">
      <Label htmlFor="syllabus-exam">Exam</Label>
      <SelectNative
        id="syllabus-exam"
        value={selectedExamId ?? ""}
        onChange={(e) => router.push(e.target.value ? `/admin/exams/syllabus?examId=${e.target.value}` : "/admin/exams/syllabus")}
      >
        <option value="">Select an exam…</option>
        {exams.map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.name} ({exam.code})
          </option>
        ))}
      </SelectNative>
    </div>
  );
}
