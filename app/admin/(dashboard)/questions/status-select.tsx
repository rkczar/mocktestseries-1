"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setQuestionStatusAction } from "./actions";
import type { QuestionStatus } from "@prisma/client";

export function StatusSelect({ questionId, status }: { questionId: string; status: QuestionStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => startTransition(() => setQuestionStatusAction(questionId, e.target.value as QuestionStatus))}
      className="h-8 w-32 text-xs"
      aria-label="Question status"
    >
      <option value="DRAFT">Draft</option>
      <option value="PUBLISHED">Published</option>
      <option value="ARCHIVED">Archived</option>
    </SelectNative>
  );
}
