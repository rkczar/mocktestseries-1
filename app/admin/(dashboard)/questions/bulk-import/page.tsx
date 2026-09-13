"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Upload, AlertCircle, CheckCircle, XCircle, FileSpreadsheet } from "lucide-react";
import type { ParsedImportRow, ValidatedImportRow } from "@/lib/bulk-import";
import type { BulkImportDuplicateStrategy } from "@prisma/client";

type ImportStep = "upload" | "validate" | "preview" | "importing" | "complete";

interface UploadResult {
  filename: string;
  total: number;
  valid: number;
  invalid: number;
  rows: ParsedImportRow[];
  parseErrors: string[];
}

interface ValidationResult {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  rows: ValidatedImportRow[];
  warnings: string[];
}

interface ImportResult {
  runId: string;
  total: number;
  successCount: number;
  skippedCount: number;
  replacedCount: number;
  failedCount: number;
  status: string;
}

export default function BulkImportPage() {
  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<BulkImportDuplicateStrategy>("SKIP");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setIsProcessing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/admin/questions/bulk-import/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Upload failed");
      }

      const data: UploadResult = await response.json();
      setUploadResult(data);
      setStep("validate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleValidate = async () => {
    if (!uploadResult) return;

    setIsProcessing(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/questions/bulk-import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: uploadResult.rows }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Validation failed");
      }

      const data: ValidationResult = await response.json();
      setValidationResult(data);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = async () => {
    if (!validationResult || !uploadResult) return;

    setIsProcessing(true);
    setError(null);
    setStep("importing");

    try {
      const response = await fetch("/api/admin/questions/bulk-import/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: validationResult.rows,
          duplicateStrategy,
          filename: uploadResult.filename,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Import failed");
      }

      const data: ImportResult = await response.json();
      setImportResult(data);
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStep("preview");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setStep("upload");
    setFile(null);
    setUploadResult(null);
    setValidationResult(null);
    setImportResult(null);
    setError(null);
    setDuplicateStrategy("SKIP");
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Bulk Import Questions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          Upload CSV, XLS, or XLSX files to import multiple questions at once.
        </p>
      </div>

      {/* Progress Steps */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            {[
              { key: "upload", label: "Upload" },
              { key: "validate", label: "Validate" },
              { key: "preview", label: "Preview" },
              { key: "complete", label: "Import" },
            ].map((s, idx) => (
              <div key={s.key} className="flex items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                    step === s.key || (s.key === "complete" && step === "importing")
                      ? "bg-[var(--color-primary)] text-white"
                      : idx < ["upload", "validate", "preview", "importing", "complete"].indexOf(step)
                        ? "bg-[var(--color-success)] text-white"
                        : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]"
                  }`}
                >
                  {idx < ["upload", "validate", "preview", "importing", "complete"].indexOf(step) ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    idx + 1
                  )}
                </div>
                <span className="ml-2 text-sm font-medium">{s.label}</span>
                {idx < 3 && <div className="mx-4 h-px w-12 bg-[var(--color-border)]" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Upload Step */}
      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle>Upload File</CardTitle>
            <CardDescription>Select a CSV, XLS, or XLSX file containing questions to import.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="file-upload"
                className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-muted)] p-8 transition hover:bg-[var(--color-surface)]"
              >
                <FileSpreadsheet className="h-12 w-12 text-[var(--color-muted-foreground)] mb-3" />
                <span className="text-sm font-medium text-[var(--color-foreground)]">
                  {file ? file.name : "Click to upload or drag and drop"}
                </span>
                <span className="text-xs text-[var(--color-muted-foreground)] mt-1">
                  CSV, XLS, XLSX (Max 10MB)
                </span>
                <input
                  id="file-upload"
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </label>
            </div>

            <div className="rounded-lg bg-[var(--color-muted)] p-4">
              <h4 className="text-sm font-medium mb-2">Required Columns:</h4>
              <div className="grid grid-cols-2 gap-2 text-xs text-[var(--color-muted-foreground)]">
                <div>• Exam</div>
                <div>• Exam Year</div>
                <div>• Subject</div>
                <div>• Topic</div>
                <div>• Sub-topic</div>
                <div>• Source</div>
                <div>• Question Text</div>
                <div>• Option A, B, C, D</div>
                <div>• Correct Answer</div>
                <div>• Difficulty</div>
                <div>• Status</div>
                <div className="text-[var(--color-foreground)]">Optional: Image, Explanation, Question Code</div>
              </div>
            </div>

            <Button onClick={handleUpload} disabled={!file || isProcessing}>
              {isProcessing ? "Parsing..." : "Parse File"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Validate Step */}
      {step === "validate" && uploadResult && (
        <Card>
          <CardHeader>
            <CardTitle>Parse Results</CardTitle>
            <CardDescription>Initial validation of uploaded data.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-foreground)]">{uploadResult.total}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Total Rows</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-success)]">{uploadResult.valid}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Valid</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-error)]">{uploadResult.invalid}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Invalid</div>
              </div>
            </div>

            {uploadResult.parseErrors.length > 0 && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <div className="font-medium mb-1">Parse Warnings:</div>
                  <ul className="list-disc list-inside text-sm">
                    {uploadResult.parseErrors.slice(0, 5).map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                    {uploadResult.parseErrors.length > 5 && (
                      <li>... and {uploadResult.parseErrors.length - 5} more</li>
                    )}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex gap-3">
              <Button onClick={handleValidate} disabled={isProcessing || uploadResult.valid === 0}>
                {isProcessing ? "Validating..." : "Validate Against Database"}
              </Button>
              <Button onClick={handleReset} variant="outline">
                Start Over
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview Step */}
      {step === "preview" && validationResult && (
        <Card>
          <CardHeader>
            <CardTitle>Import Preview</CardTitle>
            <CardDescription>Review validation results before importing.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-4">
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-foreground)]">{validationResult.total}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Total</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-success)]">{validationResult.valid}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Valid</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-warning)]">{validationResult.duplicates}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Duplicates</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-error)]">{validationResult.invalid}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Invalid</div>
              </div>
            </div>

            {validationResult.duplicates > 0 && (
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <h4 className="text-sm font-medium mb-2">Duplicate Handling Strategy:</h4>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="SKIP"
                      checked={duplicateStrategy === "SKIP"}
                      onChange={(e) => setDuplicateStrategy(e.target.value as BulkImportDuplicateStrategy)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">Skip duplicates (do not import)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="REPLACE"
                      checked={duplicateStrategy === "REPLACE"}
                      onChange={(e) => setDuplicateStrategy(e.target.value as BulkImportDuplicateStrategy)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">Replace existing questions</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="ADD_AS_NEW"
                      checked={duplicateStrategy === "ADD_AS_NEW"}
                      onChange={(e) => setDuplicateStrategy(e.target.value as BulkImportDuplicateStrategy)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">Add as new questions (allow duplicates)</span>
                  </label>
                </div>
              </div>
            )}

            {validationResult.warnings.length > 0 && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <div className="font-medium mb-1">Warnings:</div>
                  <ul className="list-disc list-inside text-sm">
                    {validationResult.warnings.slice(0, 3).map((warn, idx) => (
                      <li key={idx}>{warn}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--color-muted)] border-b border-[var(--color-border)]">
                  <tr>
                    <th className="px-3 py-2 text-left">Row</th>
                    <th className="px-3 py-2 text-left">Question</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {validationResult.rows.slice(0, 50).map((row) => (
                    <tr key={row.rowNumber} className="border-b border-[var(--color-border)]">
                      <td className="px-3 py-2">{row.rowNumber}</td>
                      <td className="px-3 py-2 max-w-xs truncate">{row.data.questionText}</td>
                      <td className="px-3 py-2">
                        {row.isValid ? (
                          row.resolvedData?.isDuplicate ? (
                            <Badge variant="warning">Duplicate</Badge>
                          ) : (
                            <Badge variant="success">Valid</Badge>
                          )
                        ) : (
                          <Badge variant="error">Invalid</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
                        {row.errors.length > 0 ? row.errors[0] : row.warnings[0] || "—"}
                      </td>
                    </tr>
                  ))}
                  {validationResult.rows.length > 50 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-center text-[var(--color-muted-foreground)]">
                        ... and {validationResult.rows.length - 50} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3">
              <Button onClick={handleImport} disabled={isProcessing || validationResult.valid === 0}>
                {isProcessing ? "Importing..." : `Import ${validationResult.valid} Questions`}
              </Button>
              <Button onClick={handleReset} variant="outline">
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Importing Step */}
      {step === "importing" && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-primary)]" />
            <p className="text-lg font-medium">Importing questions...</p>
            <p className="text-sm text-[var(--color-muted-foreground)]">This may take a few moments.</p>
          </CardContent>
        </Card>
      )}

      {/* Complete Step */}
      {step === "complete" && importResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-6 w-6 text-[var(--color-success)]" />
              Import Complete
            </CardTitle>
            <CardDescription>Import run #{importResult.runId}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-4">
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-success)]">{importResult.successCount}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Created</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-warning)]">{importResult.skippedCount}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Skipped</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-primary)]">{importResult.replacedCount}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Replaced</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-2xl font-bold text-[var(--color-error)]">{importResult.failedCount}</div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Failed</div>
              </div>
            </div>

            <div className="flex gap-3">
              <Button onClick={handleReset}>Import More Questions</Button>
              <Button variant="outline" asChild>
                <a href={`/admin/questions/bulk-import/history/${importResult.runId}`}>View Import Details</a>
              </Button>
              <Button variant="outline" asChild>
                <a href="/admin/questions">Go to Question Bank</a>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
