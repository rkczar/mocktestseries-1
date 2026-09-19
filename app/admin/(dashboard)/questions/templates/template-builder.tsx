"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import {
  COLUMN_DEFS,
  COLUMN_GROUPS,
  PRESETS,
  REQUIRED_CORE_KEYS,
  getRequirement,
  validateSelection,
  FILE_FORMATS,
  type PresetId,
  type FileFormat,
} from "./presets";

interface SubTopicData {
  id: string;
  name: string;
}
interface TopicData {
  id: string;
  name: string;
  subTopics: SubTopicData[];
}
interface SubjectData {
  id: string;
  name: string;
  topics: TopicData[];
}
interface PaperData {
  id: string;
  year: number;
  title: string;
}
export interface ExamContextData {
  id: string;
  name: string;
  code: string;
  subjects: SubjectData[];
  previousYearPapers: PaperData[];
}

function requirementBadge(level: "REQUIRED" | "OPTIONAL" | "CONDITIONAL") {
  if (level === "REQUIRED") return <Badge variant="error">Required</Badge>;
  if (level === "CONDITIONAL") return <Badge variant="warning">Conditional</Badge>;
  return <Badge variant="neutral">Optional</Badge>;
}

export function TemplateBuilder({ exams }: { exams: ExamContextData[] }) {
  const [format, setFormat] = useState<FileFormat>("csv");
  const [presetId, setPresetId] = useState<PresetId>("BASIC_MCQ");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set<string>([...PRESETS.BASIC_MCQ.defaultChecked, ...REQUIRED_CORE_KEYS])
  );

  const [examId, setExamId] = useState<string>("");
  const [subjectId, setSubjectId] = useState<string>("");
  const [year, setYear] = useState<string>("");
  const [paperId, setPaperId] = useState<string>("");

  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedExam = exams.find((e) => e.id === examId);
  const selectedSubject = selectedExam?.subjects.find((s) => s.id === subjectId);

  function applyPreset(id: PresetId) {
    setPresetId(id);
    const preset = PRESETS[id];
    const next = new Set<string>(REQUIRED_CORE_KEYS);
    preset.defaultChecked.forEach((k) => next.add(k));
    setSelected(next);
    setError(null);
  }

  function toggleColumn(key: string) {
    const requirement = getRequirement(presetId, key);
    if (requirement === "REQUIRED") return; // locked on, always part of an importable template
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectionCheck = useMemo(() => validateSelection([...selected]), [selected]);

  async function handleDownload() {
    setError(null);
    if (!selectionCheck.ok) {
      setError(
        `Can't generate this template — it's missing required column(s): ${selectionCheck.missingLabels.join(", ")}. A file without these can never be imported.`
      );
      return;
    }

    setIsDownloading(true);
    try {
      const res = await fetch("/api/admin/questions/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          columns: [...selected],
          presetId,
          examId: examId || undefined,
          subjectId: subjectId || undefined,
          year: year || undefined,
          paperId: paperId || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to generate template (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `question-template.${format}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate template");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Templates</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Build and download a CSV or XLSX template pre-shaped for Bulk Import — pick a preset or customize the
          columns, then download.
        </p>
      </div>

      {/* Preset */}
      <Card>
        <CardHeader>
          <CardTitle>1. Choose a preset</CardTitle>
          <CardDescription>Presets choose which columns are included — you can still fine-tune below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {Object.values(PRESETS).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={`flex flex-col gap-1 rounded-[var(--radius-button)] border p-3 text-left transition-colors ${
                  presetId === preset.id
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
                    : "border-[var(--color-border)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)]"
                }`}
              >
                <span className="text-sm font-medium text-[var(--color-foreground)]">{preset.name}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">{preset.description}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Format */}
      <Card>
        <CardHeader>
          <CardTitle>2. File format</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {FILE_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={`flex items-center gap-2 rounded-[var(--radius-button)] border px-4 py-2 text-sm transition-colors ${
                  format === f.id
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-foreground)]"
                    : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)]"
                }`}
              >
                {f.id === "csv" ? <FileText className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                {f.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Exam context */}
      <Card>
        <CardHeader>
          <CardTitle>3. Exam context (optional)</CardTitle>
          <CardDescription>
            Optionally scope the template to a real Exam / Subject / Paper. This fills in the VALID VALUES sheet and
            the example row — it does not change which columns are available.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exam-select">Exam</Label>
              <SelectNative
                id="exam-select"
                value={examId}
                onChange={(e) => {
                  setExamId(e.target.value);
                  setSubjectId("");
                  setPaperId("");
                }}
              >
                <option value="">None</option>
                {exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="year-select">Year</Label>
              <SelectNative id="year-select" value={year} onChange={(e) => setYear(e.target.value)} disabled={!selectedExam}>
                <option value="">None</option>
                {selectedExam?.previousYearPapers
                  .map((p) => p.year)
                  .filter((y, i, arr) => arr.indexOf(y) === i)
                  .map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="paper-select">Paper / PYQ</Label>
              <SelectNative
                id="paper-select"
                value={paperId}
                onChange={(e) => setPaperId(e.target.value)}
                disabled={!selectedExam}
              >
                <option value="">None</option>
                {selectedExam?.previousYearPapers
                  .filter((p) => !year || String(p.year) === year)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.year})
                    </option>
                  ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="subject-select">Subject</Label>
              <SelectNative
                id="subject-select"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                disabled={!selectedExam}
              >
                <option value="">None</option>
                {selectedExam?.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectNative>
            </div>
          </div>
          {selectedSubject && (
            <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
              {selectedSubject.topics.length} topic(s) /{" "}
              {selectedSubject.topics.reduce((n, t) => n + t.subTopics.length, 0)} sub-topic(s) will be listed in the
              VALID VALUES sheet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Columns */}
      <Card>
        <CardHeader>
          <CardTitle>4. Columns</CardTitle>
          <CardDescription>
            Toggle columns on or off. Columns marked <Badge variant="error">Required</Badge> can&apos;t be removed —
            the bulk importer can&apos;t process a file without them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {COLUMN_GROUPS.map((group) => {
            const columns = COLUMN_DEFS.filter((c) => c.group === group.id);
            return (
              <div key={group.id} className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  {group.title}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {columns.map((col) => {
                    const requirement = getRequirement(presetId, col.key);
                    const checked = selected.has(col.key);
                    return (
                      <label
                        key={col.key}
                        className={`flex items-start gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] p-2.5 ${
                          requirement === "REQUIRED" ? "opacity-90" : "cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)]"
                        }`}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={requirement === "REQUIRED"}
                          onCheckedChange={() => toggleColumn(col.key)}
                          className="mt-0.5"
                        />
                        <span className="flex flex-1 flex-col gap-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm text-[var(--color-foreground)]">{col.label}</span>
                            {requirementBadge(requirement)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-muted)] p-4">
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {selected.size} column{selected.size === 1 ? "" : "s"} selected · {format.toUpperCase()}
        </div>
        <Button onClick={handleDownload} disabled={isDownloading}>
          <Download className="h-4 w-4" />
          {isDownloading ? "Generating…" : "Download Template"}
        </Button>
      </div>
    </div>
  );
}
