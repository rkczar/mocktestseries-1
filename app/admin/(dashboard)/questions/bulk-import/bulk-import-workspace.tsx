"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertCircle, CheckCircle, FileSpreadsheet, Download, RefreshCw } from "lucide-react";

interface ExamOption {
  id: string;
  name: string;
  year: number | null;
}

interface PaperOption {
  id: string;
  examId: string;
  year: number;
  title: string;
  paperCode: string | null;
}

type RowFilter = "all" | "valid" | "warning" | "error" | "hasImage" | "missingImage" | "reviewRequired";

interface RowData {
  rowNumber: number;
  exam: string;
  examYear: string;
  questionCode?: string;
  questionNumber?: string;
  subject: string;
  topic: string;
  subTopic: string;
  source: string;
  questionText: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: string;
  explanation?: string;
  difficulty: string;
  image?: string;
  questionImageFilename?: string;
  optionAImageFilename?: string;
  optionBImageFilename?: string;
  optionCImageFilename?: string;
  optionDImageFilename?: string;
  status: string;
}

interface ImageMatch {
  field: string;
  filename: string;
  status: "FOUND" | "MISSING";
}

interface StagedRow {
  id: string;
  rowNumber: number;
  status: string;
  severity: "VALID" | "WARNING" | "ERROR";
  questionId: string | null;
  questionCode: string | null;
  errors: string[];
  warnings: string[];
  rawData: unknown;
  editedData: unknown;
  merged: RowData;
  removedFromImport: boolean;
  reviewRequired: boolean;
  targetStatus: string | null;
  imageMatches: ImageMatch[];
}

interface RunSummary {
  total: number;
  valid: number;
  warnings: number;
  errors: number;
  duplicates: number;
  newQuestions: number;
  updates: number;
  drafts: number;
  skipped: number;
  hasImages: number;
  missingImages: number;
  reviewRequired: number;
}

interface RunInfo {
  id: string;
  filename: string;
  format: string | null;
  label: string | null;
  examId: string | null;
  exam: { id: string; name: string } | null;
  examYear: number | null;
  previousYearPaperId: string | null;
  previousYearPaper: { id: string; title: string } | null;
  status: string;
  duplicateStrategy: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  warningRows: number;
  reviewRequiredCount: number;
  successCount: number;
  skippedCount: number;
  replacedCount: number;
  failedCount: number;
  draftCount: number;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

const FILTER_CHIPS: { key: RowFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "valid", label: "Valid" },
  { key: "warning", label: "Warning" },
  { key: "error", label: "Error" },
  { key: "hasImage", label: "Has Image" },
  { key: "missingImage", label: "Missing Image" },
  { key: "reviewRequired", label: "Review Required" },
];

const SEVERITY_VARIANT = { VALID: "success", WARNING: "warning", ERROR: "error" } as const;
const PAGE_SIZE_OPTIONS = ["25", "50", "100", "all"] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

type ColumnMode = "SET" | "CLEAR" | "IGNORE" | "KEEP";

interface ColumnDef {
  key: keyof RowData;
  label: string;
  required: boolean;
}

const MANAGED_COLUMNS: ColumnDef[] = [
  { key: "questionCode", label: "Question Code", required: false },
  { key: "questionNumber", label: "Question Number", required: false },
  { key: "exam", label: "Exam", required: false },
  { key: "examYear", label: "Year", required: false },
  { key: "subject", label: "Subject", required: true },
  { key: "topic", label: "Topic", required: false },
  { key: "subTopic", label: "SubTopic", required: false },
  { key: "questionText", label: "Question Text", required: true },
  { key: "optionA", label: "Option A", required: true },
  { key: "optionB", label: "Option B", required: true },
  { key: "optionC", label: "Option C", required: true },
  { key: "optionD", label: "Option D", required: true },
  { key: "correctAnswer", label: "Correct Answer", required: false },
  { key: "explanation", label: "Explanation", required: false },
  { key: "difficulty", label: "Difficulty", required: false },
  { key: "source", label: "Source", required: false },
  { key: "status", label: "Status", required: false },
  { key: "questionImageFilename", label: "Question Image Filename", required: false },
  { key: "optionAImageFilename", label: "Option A Image Filename", required: false },
  { key: "optionBImageFilename", label: "Option B Image Filename", required: false },
  { key: "optionCImageFilename", label: "Option C Image Filename", required: false },
  { key: "optionDImageFilename", label: "Option D Image Filename", required: false },
];

export function BulkImportWorkspace({ exams, papers }: { exams: ExamOption[]; papers: PaperOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialRunId = searchParams.get("runId");

  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [page, setPage] = useState(1);
  const [pageSizeOption, setPageSizeOption] = useState<PageSizeOption>("25");
  const [totalPages, setTotalPages] = useState(1);
  const [totalRows, setTotalRows] = useState(0);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyScope, setApplyScope] = useState<"selected" | "all">("selected");
  const [columnState, setColumnState] = useState<Record<string, ColumnMode>>({});
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<StagedRow | null>(null);
  const [importResult, setImportResult] = useState<{ successCount: number; skippedCount: number; replacedCount: number; failedCount: number; status: string } | null>(null);

  // --- Upload form state -----------------------------------------------
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [examId, setExamId] = useState("");
  const [examYear, setExamYear] = useState("");
  const [previousYearPaperId, setPreviousYearPaperId] = useState("");
  const [duplicateStrategy, setDuplicateStrategy] = useState("SKIP");
  const [uploading, setUploading] = useState(false);
  const [validating, setValidating] = useState(false);

  // --- Change Exam (after staging) --------------------------------------
  const [showChangeExam, setShowChangeExam] = useState(false);
  const [changeExamId, setChangeExamId] = useState("");
  const [changingExam, setChangingExam] = useState(false);

  const selectedExam = exams.find((e) => e.id === examId);
  const papersForExam = papers.filter((p) => p.examId === examId);

  const loadRun = useCallback(
    async (id: string, opts?: { page?: number; filter?: RowFilter; pageSize?: PageSizeOption }) => {
      setLoading(true);
      setError(null);
      try {
        const p = opts?.page ?? page;
        const f = opts?.filter ?? filter;
        const ps = opts?.pageSize ?? pageSizeOption;
        const res = await fetch(`/api/admin/questions/bulk-import/runs/${id}?page=${p}&pageSize=${ps}&filter=${f}`);
        if (!res.ok) throw new Error((await res.json()).error || "Failed to load import run");
        const data = await res.json();
        setRun(data.run);
        setRows(data.rows);
        setSummary(data.summary);
        setTotalPages(data.totalPages);
        setTotalRows(data.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load import run");
      } finally {
        setLoading(false);
      }
    },
    [page, filter, pageSizeOption]
  );

  useEffect(() => {
    // loadRun is a fetch-then-setState data loader (standard "load on mount /
    // param change" pattern) — its setLoading(true) at the top is not a
    // synchronous render-cascade the set-state-in-effect rule is meant to
    // catch, since the real state updates happen after the awaited fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (runId) loadRun(runId, { page, filter, pageSize: pageSizeOption });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, page, filter, pageSizeOption]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file || !examId) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (label) formData.append("label", label);
      formData.append("examId", examId);
      if (examYear) formData.append("examYear", examYear);
      if (previousYearPaperId) formData.append("previousYearPaperId", previousYearPaperId);
      formData.append("duplicateStrategy", duplicateStrategy);

      const res = await fetch("/api/admin/questions/bulk-import/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
      const data = await res.json();

      setUploading(false);
      setValidating(true);
      const validateRes = await fetch("/api/admin/questions/bulk-import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: data.runId }),
      });
      if (!validateRes.ok) throw new Error((await validateRes.json()).error || "Validation failed");

      setRunId(data.runId);
      router.replace(`/admin/questions/bulk-import?runId=${data.runId}`);
      setPage(1);
      setFilter("all");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setValidating(false);
    }
  };

  const handleReset = () => {
    setRunId(null);
    setRun(null);
    setRows([]);
    setSummary(null);
    setImportResult(null);
    setFile(null);
    setLabel("");
    setExamId("");
    setExamYear("");
    setPreviousYearPaperId("");
    setDuplicateStrategy("SKIP");
    setPageSizeOption("25");
    setApplyScope("selected");
    setColumnState({});
    router.replace("/admin/questions/bulk-import");
  };

  const handleChangeExam = async () => {
    if (!runId || !changeExamId) return;
    setChangingExam(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/questions/bulk-import/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId: changeExamId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to change Exam");
      setShowChangeExam(false);
      setNotice("Import Exam context changed — every staged row was re-validated against the new Exam.");
      await loadRun(runId, { page, filter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change Exam");
    } finally {
      setChangingExam(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllOnPage = () => {
    setSelected((prev) => {
      const allOnPage = rows.map((r) => r.id);
      const allSelected = allOnPage.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) allOnPage.forEach((id) => next.delete(id));
      else allOnPage.forEach((id) => next.add(id));
      return next;
    });
  };

  // "all" scope sends an empty rowIds array, which the backend treats as
  // "every non-removed row in the run" — including rows off the current
  // page/filter, not just what's currently selected.
  const scopedRowIds = (): string[] => (applyScope === "all" ? [] : Array.from(selected));

  const runBulkAction = async (action: string, rowIds?: string[]) => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/questions/bulk-import/runs/${runId}/bulk-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, rowIds: rowIds ?? scopedRowIds() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Bulk action failed");
      const data = await res.json();
      setSelected(new Set());
      setNotice(`${action.replace(/_/g, " ")}: ${data.affected ?? 0} row(s) affected`);
      await loadRun(runId, { page, filter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setLoading(false);
    }
  };

  const runColumnAction = async (mode: ColumnMode, column: string, value?: string) => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const actionByMode: Record<ColumnMode, string> = {
        SET: "SET_COLUMN",
        CLEAR: "CLEAR_COLUMN",
        IGNORE: "IGNORE_COLUMN",
        KEEP: "KEEP_COLUMN",
      };
      const res = await fetch(`/api/admin/questions/bulk-import/runs/${runId}/bulk-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionByMode[mode], column, value, rowIds: scopedRowIds() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Column action failed");
      const data = await res.json();
      setColumnState((prev) => ({ ...prev, [column]: mode }));
      setNotice(`${column}: ${mode.toLowerCase()} applied to ${data.affected ?? 0} row(s)`);
      await loadRun(runId, { page, filter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Column action failed");
    } finally {
      setLoading(false);
    }
  };

  const patchRow = async (rowId: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/questions/bulk-import/rows/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to update row");
      if (runId) await loadRun(runId, { page, filter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update row");
    }
  };

  const handleImport = async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/questions/bulk-import/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Import failed");
      const data = await res.json();
      setImportResult(data);
      await loadRun(runId, { page, filter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const filterCounts = useMemo((): Partial<Record<RowFilter, number>> => {
    if (!summary) return {};
    return {
      all: summary.total,
      valid: summary.valid,
      warning: summary.warnings,
      error: summary.errors,
      hasImage: summary.hasImages,
      missingImage: summary.missingImages,
      reviewRequired: summary.reviewRequired,
    } as Record<RowFilter, number>;
  }, [summary]);

  return (
    <div className="flex flex-col gap-6 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Bulk Import Questions</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Upload CSV, XLS, or XLSX files, validate and fix rows, then import.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/questions/templates">Download Template</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/admin/questions/bulk-import/history">Import History</Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {!runId && (
        <Card>
          <CardHeader>
            <CardTitle>Import Questions For</CardTitle>
            <CardDescription>
              Choose which Exam these questions belong to before uploading a file. Every existing Exam is listed — none are hardcoded.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-foreground)]">Select Exam *</label>
                <SelectNative
                  value={examId}
                  onChange={(e) => {
                    setExamId(e.target.value);
                    setPreviousYearPaperId("");
                  }}
                  className={!examId ? "border-[var(--color-warning)]" : undefined}
                >
                  <option value="">— Select an Exam —</option>
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>
                      {exam.name}
                      {exam.year ? ` (${exam.year})` : ""}
                    </option>
                  ))}
                </SelectNative>
                {exams.length === 0 ? (
                  <p className="text-xs text-[var(--color-error)]">No exams exist yet — create one under Exams &gt; All Exams first.</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Previous Year Paper (optional)</label>
                <SelectNative
                  value={previousYearPaperId}
                  onChange={(e) => setPreviousYearPaperId(e.target.value)}
                  disabled={!examId}
                >
                  <option value="">— Import to Question Bank only, link later —</option>
                  {papersForExam.map((paper) => (
                    <option key={paper.id} value={paper.id}>
                      {paper.year} — {paper.title}
                      {paper.paperCode ? ` (${paper.paperCode})` : ""}
                    </option>
                  ))}
                </SelectNative>
              </div>
            </div>

            {examId ? (
              <Alert>
                <AlertDescription className="text-sm">
                  Importing into: <strong>{selectedExam?.name}</strong>
                  {previousYearPaperId ? (
                    <>
                      {" "}
                      → linked to paper{" "}
                      <strong>{papersForExam.find((p) => p.id === previousYearPaperId)?.title}</strong>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Select an Exam above to unlock file upload.</AlertDescription>
              </Alert>
            )}

            <label
              htmlFor="file-upload"
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-muted)] p-8 transition ${
                examId ? "cursor-pointer hover:bg-[var(--color-surface)]" : "cursor-not-allowed opacity-50"
              }`}
            >
              <FileSpreadsheet className="h-12 w-12 text-[var(--color-muted-foreground)] mb-3" />
              <span className="text-sm font-medium text-[var(--color-foreground)]">
                {file ? file.name : "Click to upload or drag and drop"}
              </span>
              <span className="text-xs text-[var(--color-muted-foreground)] mt-1">CSV, XLS, XLSX (Max 10MB)</span>
              <input id="file-upload" type="file" accept=".csv,.xls,.xlsx" onChange={handleFileSelect} className="hidden" disabled={!examId} />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Batch label (optional)</label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. NEET UG 2026 Code 12" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Exam year (optional)</label>
                <Input value={examYear} onChange={(e) => setExamYear(e.target.value)} placeholder={selectedExam?.year ? String(selectedExam.year) : "2026"} />
                <span className="text-[10px] text-[var(--color-muted-foreground)]">Falls back to the selected Exam&apos;s year if left blank.</span>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Duplicate strategy</label>
                <SelectNative value={duplicateStrategy} onChange={(e) => setDuplicateStrategy(e.target.value)}>
                  <option value="SKIP">Skip duplicates</option>
                  <option value="REPLACE">Replace existing</option>
                  <option value="ADD_AS_NEW">Add as new</option>
                </SelectNative>
              </div>
            </div>

            <div className="rounded-lg bg-[var(--color-muted)] p-4">
              <h4 className="text-sm font-medium mb-2">Columns recognized:</h4>
              <div className="grid grid-cols-2 gap-2 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-3">
                <div>Exam</div>
                <div>Exam Year</div>
                <div>Subject*</div>
                <div>Topic</div>
                <div>Sub-topic</div>
                <div>Source</div>
                <div>Question Text*</div>
                <div>Option A-D*</div>
                <div>Correct Answer</div>
                <div>Difficulty</div>
                <div>Status</div>
                <div>Question Code</div>
                <div>Question Number</div>
                <div>Question/Option Image Filename</div>
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)] mt-2">
                * has no default — a row missing it can&apos;t become a Question yet. Every other column is optional metadata: if it&apos;s
                missing or you ignore it in Manage Columns, the row is still staged and imported, just saved as Draft / Review Required
                instead of being silently Published. Exam/Exam Year default to the Exam selected above.
              </p>
            </div>

            <Button onClick={handleUpload} disabled={!file || !examId || uploading || validating}>
              {uploading ? "Uploading..." : validating ? "Validating..." : "Upload & Validate"}
            </Button>
          </CardContent>
        </Card>
      )}

      {runId && run && (
        <>
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                Importing into: <strong>{run.exam?.name ?? "No Exam selected"}</strong>
                {run.previousYearPaper ? (
                  <>
                    {" "}
                    → linked to paper <strong>{run.previousYearPaper.title}</strong>
                  </>
                ) : null}
              </span>
              <Button
                size="compact"
                variant="outline"
                onClick={() => {
                  setChangeExamId(run.examId ?? "");
                  setShowChangeExam(true);
                }}
              >
                Change Exam
              </Button>
            </AlertDescription>
          </Alert>

          {showChangeExam && (
            <Dialog open onOpenChange={(open) => !open && setShowChangeExam(false)}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Change Import Exam</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      This run already has {summary?.total ?? run.totalRows} staged row(s). Changing the Exam re-validates every row against
                      the new Exam context — rows whose file Exam text doesn&apos;t match the new Exam will use the new Exam anyway, and any
                      Exam-Year fallback will be recomputed.
                    </AlertDescription>
                  </Alert>
                  <SelectNative value={changeExamId} onChange={(e) => setChangeExamId(e.target.value)}>
                    <option value="">— Select an Exam —</option>
                    {exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.name}
                      </option>
                    ))}
                  </SelectNative>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setShowChangeExam(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleChangeExam} disabled={!changeExamId || changingExam}>
                      {changingExam ? "Changing…" : "Change Exam & Re-validate"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>{run.label || run.filename}</CardTitle>
                  <CardDescription>
                    {run.filename} • {run.format ?? "—"} {run.exam ? `• ${run.exam.name}` : ""} {run.examYear ? `${run.examYear}` : ""}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="neutral">{run.status}</Badge>
                  <Button variant="outline" size="sm" onClick={handleReset}>
                    Start New Import
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {summary && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {[
                    ["Total Rows", summary.total, ""],
                    ["Valid", summary.valid, "text-[var(--color-success)]"],
                    ["Warnings", summary.warnings, "text-[var(--color-warning)]"],
                    ["Errors", summary.errors, "text-[var(--color-error)]"],
                    ["Duplicates", summary.duplicates, "text-[var(--color-warning)]"],
                    ["New Questions", summary.newQuestions, ""],
                    ["Updates", summary.updates, ""],
                    ["Drafts", summary.drafts, ""],
                    ["Skipped", summary.skipped, ""],
                    ["Has Images", summary.hasImages, ""],
                    ["Missing Images", summary.missingImages, "text-[var(--color-warning)]"],
                    ["Review Required", summary.reviewRequired, "text-[var(--color-warning)]"],
                  ].map(([labelText, value, cls]) => (
                    <div key={labelText as string} className="rounded-lg border border-[var(--color-border)] p-3">
                      <div className={`text-xl font-bold text-[var(--color-foreground)] ${cls}`}>{value as number}</div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">{labelText as string}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {importResult && (
            <Alert variant={importResult.failedCount > 0 ? "destructive" : "default"}>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>
                Import finished ({importResult.status}): {importResult.successCount} created, {importResult.skippedCount} skipped,{" "}
                {importResult.replacedCount} replaced, {importResult.failedCount} failed.{" "}
                <Link href={`/admin/questions/bulk-import/history/${runId}`} className="underline">
                  View details
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {/* Sticky toolbar */}
          <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-3 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-4 py-3 backdrop-blur">
            <div className="flex flex-wrap gap-2">
              {FILTER_CHIPS.map((chip) => (
                <button
                  key={chip.key}
                  onClick={() => {
                    setFilter(chip.key);
                    setPage(1);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    filter === chip.key
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                      : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  }`}
                >
                  {chip.label}
                  {filterCounts[chip.key] !== undefined && <span className="ml-1 opacity-70">({filterCounts[chip.key]})</span>}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] pb-3">
              <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Apply bulk actions to:</span>
              <div className="flex rounded-md border border-[var(--color-border)] p-0.5 text-xs">
                <button
                  onClick={() => setApplyScope("selected")}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    applyScope === "selected" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted-foreground)]"
                  }`}
                >
                  Selected Rows ({selected.size})
                </button>
                <button
                  onClick={() => setApplyScope("all")}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    applyScope === "all" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted-foreground)]"
                  }`}
                >
                  All Rows in Import ({summary?.total ?? 0})
                </button>
              </div>
              <Button size="sm" variant="outline" onClick={() => setShowColumnManager(true)}>
                Manage Columns
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(() => {
                const scopeEmpty = applyScope === "selected" && selected.size === 0;
                return (
                  <>
                    <Button size="sm" variant="outline" disabled={scopeEmpty || loading} onClick={() => runBulkAction("IMPORT_VALID_ONLY")}>
                      Import Valid Only
                    </Button>
                    <Button size="sm" variant="outline" disabled={scopeEmpty || loading} onClick={() => runBulkAction("MOVE_TO_DRAFT")}>
                      Move to Draft
                    </Button>
                    <Button size="sm" variant="outline" disabled={scopeEmpty || loading} onClick={() => runBulkAction("MARK_REVIEW_REQUIRED")}>
                      Mark Review Required
                    </Button>
                    <Button size="sm" variant="outline" disabled={scopeEmpty || loading} onClick={() => runBulkAction("REMOVE_FROM_IMPORT")}>
                      Remove
                    </Button>
                    <Button size="sm" variant="outline" disabled={scopeEmpty || loading} onClick={() => runBulkAction("REVALIDATE")}>
                      <RefreshCw className="h-3 w-3" /> Revalidate
                    </Button>
                  </>
                );
              })()}
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/admin/questions/bulk-import/runs/${runId}/error-report`}>
                  <Download className="h-3 w-3" /> Error Report
                </a>
              </Button>
              <div className="ml-auto">
                <Button onClick={handleImport} disabled={loading || summary?.total === 0}>
                  Import Questions
                </Button>
              </div>
            </div>
          </div>

          {showColumnManager && (
            <ColumnManagerDialog
              columnState={columnState}
              applyScope={applyScope}
              selectedCount={selected.size}
              totalCount={summary?.total ?? 0}
              onClose={() => setShowColumnManager(false)}
              onApply={runColumnAction}
              loading={loading}
            />
          )}

          <div className="max-h-[70vh] overflow-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full min-w-[1400px] text-sm">
              <thead className="sticky top-0 bg-[var(--color-muted)] border-b border-[var(--color-border)]">
                <tr>
                  <th className="px-2 py-2">
                    <Checkbox checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onCheckedChange={toggleSelectAllOnPage} />
                  </th>
                  <th className="px-3 py-2 text-left">Row</th>
                  <th className="px-3 py-2 text-left">Code</th>
                  <th className="px-3 py-2 text-left">Question</th>
                  <th className="px-3 py-2 text-left">Exam</th>
                  <th className="px-3 py-2 text-left">Year</th>
                  <th className="px-3 py-2 text-left">Subject</th>
                  <th className="px-3 py-2 text-left">Topic</th>
                  <th className="px-3 py-2 text-left">SubTopic</th>
                  <th className="px-3 py-2 text-left">Answer</th>
                  <th className="px-3 py-2 text-left">Difficulty</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-left">Images</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Validation</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={`border-b border-[var(--color-border)] ${row.removedFromImport ? "opacity-40" : ""}`}>
                    <td className="px-2 py-2">
                      <Checkbox checked={selected.has(row.id)} onCheckedChange={() => toggleSelected(row.id)} />
                    </td>
                    <td className="px-3 py-2">{row.rowNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.merged.questionCode || row.questionCode || "—"}</td>
                    <td className="px-3 py-2 max-w-xs truncate" title={row.merged.questionText}>
                      {row.merged.questionText}
                    </td>
                    <td className="px-3 py-2">{row.merged.exam}</td>
                    <td className="px-3 py-2">{row.merged.examYear}</td>
                    <td className="px-3 py-2">{row.merged.subject}</td>
                    <td className="px-3 py-2">{row.merged.topic}</td>
                    <td className="px-3 py-2">{row.merged.subTopic}</td>
                    <td className="px-3 py-2">{row.merged.correctAnswer}</td>
                    <td className="px-3 py-2">{row.merged.difficulty}</td>
                    <td className="px-3 py-2">{row.merged.source}</td>
                    <td className="px-3 py-2">
                      {row.imageMatches.length === 0 ? (
                        <span className="text-[var(--color-muted-foreground)]">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {row.imageMatches.map((m) => (
                            <Badge key={m.field} variant={m.status === "FOUND" ? "success" : "warning"}>
                              {m.field}: {m.status}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{row.targetStatus || row.merged.status || "DRAFT"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <Badge variant={SEVERITY_VARIANT[row.severity]}>{row.severity}</Badge>
                        {row.reviewRequired && <Badge variant="info">Review</Badge>}
                        {row.removedFromImport && <Badge variant="neutral">Removed</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Button size="compact" variant="outline" onClick={() => setEditingRow(row)}>
                          Edit
                        </Button>
                        {!row.removedFromImport ? (
                          <Button size="compact" variant="outline" onClick={() => patchRow(row.id, { removedFromImport: true })}>
                            Remove
                          </Button>
                        ) : (
                          <Button size="compact" variant="outline" onClick={() => patchRow(row.id, { removedFromImport: false })}>
                            Restore
                          </Button>
                        )}
                        <Button size="compact" variant="outline" onClick={() => patchRow(row.id, { targetStatus: "DRAFT" })}>
                          Draft
                        </Button>
                        <Button size="compact" variant="outline" onClick={() => patchRow(row.id, { reviewRequired: true })}>
                          Flag
                        </Button>
                        <Button size="compact" variant="outline" onClick={() => patchRow(row.id, { revalidate: true })}>
                          Revalidate
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={15} className="px-3 py-8 text-center text-[var(--color-muted-foreground)]">
                      {loading ? "Loading..." : "No rows match this filter."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {pageSizeOption === "all" ? `Showing all ${totalRows} row(s)` : `Page ${page} of ${totalPages} (${totalRows} row(s))`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                <span>Rows per page:</span>
                {PAGE_SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => {
                      setPageSizeOption(opt);
                      setPage(1);
                    }}
                    className={`rounded px-2 py-1 font-medium transition-colors ${
                      pageSizeOption === opt
                        ? "bg-[var(--color-primary)] text-white"
                        : "border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                    }`}
                  >
                    {opt === "all" ? "Show All" : opt}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pageSizeOption === "all" || page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pageSizeOption === "all" || page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {editingRow && (
        <RowEditDialog
          row={editingRow}
          onClose={() => setEditingRow(null)}
          onSave={async (edited, extra) => {
            await patchRow(editingRow.id, { editedData: edited, ...extra });
            setEditingRow(null);
          }}
        />
      )}
    </div>
  );
}

function RowEditDialog({
  row,
  onClose,
  onSave,
}: {
  row: StagedRow;
  onClose: () => void;
  onSave: (edited: Partial<RowData>, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState<RowData>({ ...row.merged });
  const [saving, setSaving] = useState(false);

  const update = (field: keyof RowData, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const diff: Partial<RowData> = {};
      (Object.keys(form) as (keyof RowData)[]).forEach((key) => {
        if (form[key] !== row.merged[key]) diff[key] = form[key] as never;
      });
      await onSave(diff, {});
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Row {row.rowNumber}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {row.errors.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                <ul className="list-disc list-inside text-xs">
                  {row.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {row.warnings.length > 0 && (
            <Alert>
              <AlertDescription>
                <ul className="list-disc list-inside text-xs">
                  {row.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Exam"><Input value={form.exam} onChange={(e) => update("exam", e.target.value)} /></Field>
            <Field label="Exam Year"><Input value={form.examYear} onChange={(e) => update("examYear", e.target.value)} /></Field>
            <Field label="Subject"><Input value={form.subject} onChange={(e) => update("subject", e.target.value)} /></Field>
            <Field label="Topic"><Input value={form.topic} onChange={(e) => update("topic", e.target.value)} /></Field>
            <Field label="Sub-topic"><Input value={form.subTopic} onChange={(e) => update("subTopic", e.target.value)} /></Field>
            <Field label="Source"><Input value={form.source} onChange={(e) => update("source", e.target.value)} /></Field>
          </div>

          <Field label="Question Text"><Textarea value={form.questionText} onChange={(e) => update("questionText", e.target.value)} rows={3} /></Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Option A"><Input value={form.optionA} onChange={(e) => update("optionA", e.target.value)} /></Field>
            <Field label="Option B"><Input value={form.optionB} onChange={(e) => update("optionB", e.target.value)} /></Field>
            <Field label="Option C"><Input value={form.optionC} onChange={(e) => update("optionC", e.target.value)} /></Field>
            <Field label="Option D"><Input value={form.optionD} onChange={(e) => update("optionD", e.target.value)} /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Correct Answer">
              <SelectNative value={form.correctAnswer} onChange={(e) => update("correctAnswer", e.target.value)}>
                {["A", "B", "C", "D"].map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </SelectNative>
            </Field>
            <Field label="Difficulty">
              <SelectNative value={form.difficulty} onChange={(e) => update("difficulty", e.target.value)}>
                {["EASY", "MEDIUM", "HARD"].map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </SelectNative>
            </Field>
          </div>

          <Field label="Explanation"><Textarea value={form.explanation || ""} onChange={(e) => update("explanation", e.target.value)} rows={2} /></Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <SelectNative value={form.status || "DRAFT"} onChange={(e) => update("status", e.target.value)}>
                {["DRAFT", "PUBLISHED", "ARCHIVED"].map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </SelectNative>
            </Field>
            <Field label="Question Code"><Input value={form.questionCode || ""} onChange={(e) => update("questionCode", e.target.value)} /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Question Image Filename"><Input value={form.questionImageFilename || ""} onChange={(e) => update("questionImageFilename", e.target.value)} /></Field>
            <Field label="Option A Image Filename"><Input value={form.optionAImageFilename || ""} onChange={(e) => update("optionAImageFilename", e.target.value)} /></Field>
            <Field label="Option B Image Filename"><Input value={form.optionBImageFilename || ""} onChange={(e) => update("optionBImageFilename", e.target.value)} /></Field>
            <Field label="Option C Image Filename"><Input value={form.optionCImageFilename || ""} onChange={(e) => update("optionCImageFilename", e.target.value)} /></Field>
            <Field label="Option D Image Filename"><Input value={form.optionDImageFilename || ""} onChange={(e) => update("optionDImageFilename", e.target.value)} /></Field>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save & Revalidate"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</label>
      {children}
    </div>
  );
}

const COLUMN_MODE_LABEL: Record<ColumnMode, string> = {
  SET: "Set for all rows",
  CLEAR: "Cleared",
  IGNORE: "Ignored",
  KEEP: "Original",
};

/**
 * "Manage Columns" — bulk edit/clear/ignore per uploaded column, scoped to
 * either the current row selection or the whole staging batch (via
 * `applyScope`, shared with the toolbar above). Each action is a single
 * server round-trip that touches every targeted row, so it always covers the
 * complete batch, not just the current page.
 */
function ColumnManagerDialog({
  columnState,
  applyScope,
  selectedCount,
  totalCount,
  onClose,
  onApply,
  loading,
}: {
  columnState: Record<string, ColumnMode>;
  applyScope: "selected" | "all";
  selectedCount: number;
  totalCount: number;
  onClose: () => void;
  onApply: (mode: ColumnMode, column: string, value?: string) => Promise<void>;
  loading: boolean;
}) {
  const [setValueDraft, setSetValueDraft] = useState<Record<string, string>>({});

  const scopeLabel = applyScope === "all" ? `all ${totalCount} row(s) in this import` : `${selectedCount} selected row(s)`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage Columns</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Alert>
            <AlertDescription className="text-xs">
              Actions below apply to <strong>{scopeLabel}</strong> (change the scope from the toolbar before opening this dialog).
              &quot;Ignore Column&quot; excludes that field from this import only — it never changes the downloadable template, the database
              schema, or existing questions. Every column can be ignored; columns marked <span className="text-[var(--color-error)]">*</span> have
              no default, so a row missing one just can&apos;t become a Question yet (it stays visible under the Error filter) — everything else
              (Exam, Year, Difficulty, Correct Answer, Status, …) safely defaults, and rows missing those are saved as Draft / Review Required
              instead of being silently Published.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {MANAGED_COLUMNS.map((col) => {
              const mode = columnState[col.key];
              return (
                <div key={col.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="flex min-w-[10rem] flex-col">
                    <span className="text-sm font-medium text-[var(--color-foreground)]">
                      {col.label}
                      {col.required && <span className="ml-1 text-[var(--color-error)]">*</span>}
                    </span>
                    <Badge variant={mode ? "info" : "neutral"}>{mode ? COLUMN_MODE_LABEL[mode] : "Original"}</Badge>
                  </div>

                  <Input
                    placeholder={`Set all ${col.label} values...`}
                    value={setValueDraft[col.key] ?? ""}
                    onChange={(e) => setSetValueDraft((prev) => ({ ...prev, [col.key]: e.target.value }))}
                    className="h-8 max-w-[14rem] flex-1 text-xs"
                    disabled={loading}
                  />
                  <Button
                    size="compact"
                    variant="outline"
                    disabled={loading || !(setValueDraft[col.key] ?? "").trim()}
                    onClick={() => onApply("SET", col.key, setValueDraft[col.key])}
                  >
                    Set All
                  </Button>
                  <Button size="compact" variant="outline" disabled={loading} onClick={() => onApply("CLEAR", col.key)}>
                    Clear All
                  </Button>
                  <Button
                    size="compact"
                    variant="outline"
                    disabled={loading}
                    title={col.required ? `${col.label} has no default — rows missing it can't become a Question yet, but ignoring it never blocks staging or import.` : undefined}
                    onClick={() => onApply("IGNORE", col.key)}
                  >
                    Ignore Column
                  </Button>
                  <Button size="compact" variant="outline" disabled={loading || !mode} onClick={() => onApply("KEEP", col.key)}>
                    Keep Original
                  </Button>
                </div>
              );
            })}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
