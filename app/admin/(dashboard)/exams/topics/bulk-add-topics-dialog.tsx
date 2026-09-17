"use client";

import { useMemo, useState, useTransition } from "react";
import { ListPlus, CheckCircle2, AlertCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { bulkCreateTopicsAction, type BulkTopicFormState } from "./actions";

interface ExamWithSubjects {
  id: string;
  name: string;
  subjects: { id: string; name: string }[];
}

export function BulkAddTopicsDialog({ exams, defaultSubjectId }: { exams: ExamWithSubjects[]; defaultSubjectId?: string }) {
  const examsWithSubjects = useMemo(() => exams.filter((e) => e.subjects.length > 0), [exams]);
  const defaultExam = examsWithSubjects.find((e) => e.subjects.some((s) => s.id === defaultSubjectId));

  const [examId, setExamId] = useState(defaultExam?.id ?? examsWithSubjects[0]?.id ?? "");
  const exam = useMemo(() => examsWithSubjects.find((e) => e.id === examId), [examsWithSubjects, examId]);
  const [subjectId, setSubjectId] = useState(defaultSubjectId ?? exam?.subjects[0]?.id ?? "");
  const subjects = exam?.subjects ?? [];

  const [names, setNames] = useState("");
  const [result, setResult] = useState<BulkTopicFormState["result"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleExamChange = (id: string) => {
    setExamId(id);
    const nextExam = examsWithSubjects.find((e) => e.id === id);
    setSubjectId(nextExam?.subjects[0]?.id ?? "");
  };

  const handleSubmit = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await bulkCreateTopicsAction(subjectId, names);
      if (res.error) setError(res.error);
      else if (res.result) {
        setResult(res.result);
        setNames("");
      }
    });
  };

  if (examsWithSubjects.length === 0) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ListPlus className="h-3.5 w-3.5" aria-hidden /> Bulk Add Topics
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Add Topics</DialogTitle>
          <DialogDescription>One topic per line. Blank lines are ignored, and duplicates under the same subject are skipped.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-exam">Exam</Label>
            <SelectNative id="bulk-exam" value={examId} onChange={(e) => handleExamChange(e.target.value)}>
              {examsWithSubjects.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-subject">Subject</Label>
            <SelectNative id="bulk-subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bulk-names">Topic names</Label>
          <textarea
            id="bulk-names"
            value={names}
            onChange={(e) => setNames(e.target.value)}
            rows={8}
            placeholder={"Diversity in Living World\nStructural Organisation in Plants and Animals\nCell Structure and Function"}
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          />
        </div>

        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        {result ? (
          <div className="flex flex-col gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3 text-sm">
            <p className="flex items-center gap-1.5 text-[var(--color-success)]">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> {result.added.length} added
            </p>
            {result.duplicates.length > 0 ? (
              <p className="flex items-center gap-1.5 text-[var(--color-warning)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {result.duplicates.length} skipped (already exist): {result.duplicates.join(", ")}
              </p>
            ) : null}
            {result.failed.length > 0 ? (
              <p className="flex items-center gap-1.5 text-[var(--color-error)]">
                <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {result.failed.length} failed:{" "}
                {result.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <Button type="button" onClick={handleSubmit} disabled={isPending || !subjectId || names.trim().length === 0}>
            {isPending ? "Adding…" : "Add Topics"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
