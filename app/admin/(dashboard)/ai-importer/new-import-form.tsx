"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createJobAction } from "./actions";

export interface ExamOption {
  id: string;
  name: string;
  code: string;
  year: number | null;
  isActive: boolean;
  subjects: { id: string; name: string }[];
  papers: { id: string; year: number; title: string; paperCode: string | null }[];
}

export function JobContextFields({
  exams,
  value,
  onChange,
}: {
  exams: ExamOption[];
  value: { examId: string; paperType: string; subjectId: string; year: string; paperCode: string; previousYearPaperId: string };
  onChange: (v: Partial<typeof value>) => void;
}) {
  const exam = exams.find((e) => e.id === value.examId);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-exam">Exam</Label>
        <SelectNative id="ai-exam" value={value.examId} onChange={(e) => onChange({ examId: e.target.value, subjectId: "", previousYearPaperId: "" })} data-testid="ai-exam">
          <option value="">Select an exam…</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.isActive ? "" : " (inactive)"}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-paper-type">Paper type</Label>
        <SelectNative id="ai-paper-type" value={value.paperType} onChange={(e) => onChange({ paperType: e.target.value })} data-testid="ai-paper-type">
          <option value="FULL_PAPER">Full previous-year paper (all subjects of the exam)</option>
          <option value="SINGLE_SUBJECT">Single-subject paper</option>
          <option value="MIXED">Mixed / other paper</option>
        </SelectNative>
      </div>
      {value.paperType === "SINGLE_SUBJECT" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-subject">Subject</Label>
          <SelectNative id="ai-subject" value={value.subjectId} onChange={(e) => onChange({ subjectId: e.target.value })} disabled={!exam} data-testid="ai-subject">
            <option value="">{exam ? "Select a subject…" : "Select the exam first"}</option>
            {exam?.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-year">Year (optional)</Label>
        <Input id="ai-year" inputMode="numeric" maxLength={4} placeholder="e.g. 2024" value={value.year} onChange={(e) => onChange({ year: e.target.value.replace(/\D/g, "") })} data-testid="ai-year" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-paper">Link to Previous Year Paper (optional)</Label>
        <SelectNative id="ai-paper" value={value.previousYearPaperId} onChange={(e) => onChange({ previousYearPaperId: e.target.value })} disabled={!exam} data-testid="ai-pyq">
          <option value="">Question Bank only</option>
          {exam?.papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.year} — {p.title}
              {p.paperCode ? ` (${p.paperCode})` : ""}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-code">Paper code (optional)</Label>
        <Input id="ai-code" maxLength={40} placeholder="e.g. Set A" value={value.paperCode} onChange={(e) => onChange({ paperCode: e.target.value })} />
      </div>
    </div>
  );
}

export function NewImportForm({ exams, defaultBudget, maxJobInr }: { exams: ExamOption[]; defaultBudget: number; maxJobInr: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [budget, setBudget] = useState(String(defaultBudget));
  const [ctx, setCtx] = useState({ examId: "", paperType: "FULL_PAPER", subjectId: "", year: "", paperCode: "", previousYearPaperId: "" });
  const ready = useMemo(() => !!ctx.examId && (ctx.paperType !== "SINGLE_SUBJECT" || !!ctx.subjectId) && title.trim().length > 0, [ctx, title]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await createJobAction({ title, ...ctx, year: ctx.year || null, subjectId: ctx.subjectId || null, previousYearPaperId: ctx.previousYearPaperId || null, paperCode: ctx.paperCode || null, budgetInr: Number(budget) });
      if (!r.ok) setError(r.error);
      else router.push(`/admin/ai-importer/jobs/${r.data.jobId}`);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="new-import-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-title">Import name</Label>
        <Input id="ai-title" maxLength={160} placeholder="e.g. RUHS MO 2024 — Paper 1" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="ai-title" />
      </div>
      <JobContextFields exams={exams} value={ctx} onChange={(v) => setCtx((c) => ({ ...c, ...v }))} />
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="ai-budget">Job budget for paid AI (₹)</Label>
        <Input id="ai-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} data-testid="ai-budget" />
        <p className="text-xs text-[var(--color-muted-foreground)]">Processing pauses before this amount would be exceeded. You confirm the estimate before anything paid runs. Hard limit per job: ₹{maxJobInr}.</p>
      </div>
      {error && <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p>}
      <div>
        <Button type="submit" disabled={!ready || pending} data-testid="create-import">
          {pending ? "Creating…" : "Create import and upload files"}
        </Button>
      </div>
    </form>
  );
}
