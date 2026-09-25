"use client";

import { useState, useTransition } from "react";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { QuestionCountPresets } from "@/components/student/question-count-presets";
import { startTestOnTheGoAction } from "./actions";

interface SubjectOption {
  id: string;
  name: string;
  questionCount: number;
}

/**
 * Test on the Go (Section 4). Availability is the same PUBLISHED question
 * count already shown in "Subjects in <Active Exam>" (Section 3) — there is
 * no separate live recount here, because per-subject availability doesn't
 * change with the question count the student picks, only with the subject.
 */
export function TestOnTheGo({ examId, subjects }: { examId: string; subjects: SubjectOption[] }) {
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [count, setCount] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (subjects.length === 0) return null;

  const subject = subjects.find((s) => s.id === subjectId);
  const available = subject?.questionCount ?? 0;
  // Display only — the server derives the real size from the live pool.
  const effectiveCount = Math.min(count, available);

  const changeSubject = (id: string) => {
    setSubjectId(id);
    setError(null);
  };
  const changeCount = (n: number) => {
    setCount(Math.max(1, Math.min(200, n)));
    setError(null);
  };

  const handleStart = () => {
    if (!subjectId) {
      setError("Select a subject to start.");
      return;
    }
    setError(null);
    const formData = new FormData();
    formData.set("examId", examId);
    formData.set("subjectId", subjectId);
    formData.set("count", String(count));
    startTransition(async () => {
      const result = await startTestOnTheGoAction({}, formData);
      if (result?.error) setError(result.error);
    });
  };

  return (
    <Card className="border-[var(--color-primary)]/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-[var(--color-primary)]" aria-hidden /> Test on the Go
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="totg-subject" className="text-xs font-medium text-[var(--color-muted-foreground)]">
            Subject
          </label>
          <SelectNative id="totg-subject" value={subjectId} onChange={(e) => changeSubject(e.target.value)}>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Questions</label>
          <QuestionCountPresets count={count} onChange={changeCount} />
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Available: {available} Question{available === 1 ? "" : "s"}
          </p>
        </div>

        {available > 0 ? (
          <p className="text-sm font-medium text-[var(--color-foreground)]">
            {effectiveCount} Question{effectiveCount === 1 ? "" : "s"} • {effectiveCount} Minute{effectiveCount === 1 ? "" : "s"}
          </p>
        ) : null}

        {available === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No questions are currently available for this subject.</p>
        ) : count > available ? (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm text-[var(--color-foreground)]">
            {available} question{available === 1 ? " is" : "s are"} currently available for this subject. Your test will start with
            all {available} available question{available === 1 ? "" : "s"}.
          </p>
        ) : null}

        <Button type="button" onClick={handleStart} disabled={isPending || !subjectId || available === 0} className="w-full">
          {isPending ? "Starting…" : "Start Test"}
        </Button>

        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
