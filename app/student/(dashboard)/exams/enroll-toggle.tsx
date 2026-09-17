"use client";

import { useState, useTransition } from "react";
import { GraduationCap, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enrollExamAction, unenrollExamAction } from "./actions";

export function EnrollToggle({ examId, initialEnrolled }: { examId: string; initialEnrolled: boolean }) {
  const [enrolled, setEnrolled] = useState(initialEnrolled);
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      variant={enrolled ? "outline" : "primary"}
      disabled={isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !enrolled;
        setEnrolled(next);
        startTransition(() => {
          (next ? enrollExamAction(examId) : unenrollExamAction(examId)).catch(() => setEnrolled(!next));
        });
      }}
    >
      {enrolled ? <Check className="h-4 w-4" aria-hidden /> : <GraduationCap className="h-4 w-4" aria-hidden />}
      {enrolled ? "Enrolled" : "Enroll"}
    </Button>
  );
}
