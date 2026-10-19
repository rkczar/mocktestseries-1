"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";

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
  hidePaper = false,
}: {
  exams: ExamOption[];
  value: { examId: string; paperType: string; subjectId: string; year: string; paperCode: string; previousYearPaperId: string };
  onChange: (v: Partial<typeof value>) => void;
  /** The exam and Previous Year Paper are chosen elsewhere on the page (only type, subject and code here). */
  hidePaper?: boolean;
}) {
  const exam = exams.find((e) => e.id === value.examId);
  const paper = exam?.papers.find((p) => p.id === value.previousYearPaperId) ?? null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {!hidePaper && (
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
      )}
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
      {!hidePaper && (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-paper">Previous Year Paper</Label>
        <SelectNative id="ai-paper" value={value.previousYearPaperId} onChange={(e) => onChange({ previousYearPaperId: e.target.value, ...(e.target.value ? { year: "", paperCode: "" } : {}) })} disabled={!exam} data-testid="ai-pyq">
          <option value="">Question Bank only</option>
          {exam?.papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.year} — {p.title}
              {p.paperCode ? ` (${p.paperCode})` : ""}
            </option>
          ))}
        </SelectNative>
      </div>
      )}
      {paper ? (
        <p className="text-xs text-[var(--color-muted-foreground)] sm:col-span-2" data-testid="ai-paper-facts">
          Year {paper.year}
          {paper.paperCode ? ` · code ${paper.paperCode}` : ""} — taken from the selected paper.
        </p>
      ) : (
        <>
          {!hidePaper && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ai-year">Year (optional)</Label>
              <Input id="ai-year" inputMode="numeric" maxLength={4} placeholder="e.g. 2024" value={value.year} onChange={(e) => onChange({ year: e.target.value.replace(/\D/g, "") })} data-testid="ai-year" />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-code">Paper code (optional)</Label>
            <Input id="ai-code" maxLength={40} placeholder="e.g. Set A" value={value.paperCode} onChange={(e) => onChange({ paperCode: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}
