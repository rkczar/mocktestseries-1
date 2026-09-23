"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Badge } from "@/components/ui/badge";

export interface TestResourceRow {
  id: string;
  type: "PAPER_PDF" | "SOLUTION_PDF" | "OMR_TEMPLATE";
  title: string;
  fileUrl: string;
  fileSizeBytes: number;
  questionCount: number | null;
  releasePolicy: "AFTER_AVAILABLE_FROM" | "AFTER_SUBMISSION" | "CUSTOM_DATE" | "DISABLED";
  isActive: boolean;
}

const TYPE_LABEL: Record<TestResourceRow["type"], string> = {
  PAPER_PDF: "Paper PDF",
  SOLUTION_PDF: "Solution PDF",
  OMR_TEMPLATE: "OMR Template",
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reusable upload + list UI for TestResource (Paper/Solution PDF, OMR
 * templates), used from both the Mock Test detail page (mockTestId-scoped)
 * and the Test Series control center (testSeriesId-scoped, or fully global
 * when scope is empty — an OMR template reusable everywhere).
 */
export function TestResourceManager({
  resources,
  allowedTypes,
  scope,
}: {
  resources: TestResourceRow[];
  allowedTypes: TestResourceRow["type"][];
  scope: { mockTestId?: string; testSeriesId?: string; examId?: string };
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData(e.currentTarget);
      if (scope.mockTestId) formData.set("mockTestId", scope.mockTestId);
      if (scope.testSeriesId) formData.set("testSeriesId", scope.testSeriesId);
      if (scope.examId) formData.set("examId", scope.examId);

      const res = await fetch("/api/admin/test-resources", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      formRef.current?.reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch("/api/admin/test-resources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Remove failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form ref={formRef} onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="type">Type</Label>
          <SelectNative id="type" name="type" defaultValue={allowedTypes[0]} required>
            {allowedTypes.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" required placeholder="e.g. OMR — 100 Questions" />
        </div>
        {allowedTypes.includes("OMR_TEMPLATE") ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="questionCount">Question Count (OMR only)</Label>
            <Input id="questionCount" name="questionCount" type="number" min={1} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="releasePolicy">Release Policy</Label>
            <SelectNative id="releasePolicy" name="releasePolicy" defaultValue="AFTER_AVAILABLE_FROM">
              <option value="AFTER_AVAILABLE_FROM">After Available From</option>
              <option value="AFTER_SUBMISSION">After Submission</option>
              <option value="CUSTOM_DATE">Custom Date</option>
              <option value="DISABLED">Disabled</option>
            </SelectNative>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="file">PDF File (max 20MB)</Label>
          <input id="file" name="file" type="file" accept="application/pdf" required className="text-sm" />
        </div>
        <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
          {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
        </div>
      </form>

      {resources.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No resources uploaded yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-[var(--color-border)]">
          {resources.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="neutral">{TYPE_LABEL[r.type]}</Badge>
                <span className="text-[var(--color-foreground)]">{r.title}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {formatBytes(r.fileSizeBytes)}
                  {r.questionCount ? ` · ${r.questionCount} Qs` : ""}
                  {r.type !== "OMR_TEMPLATE" ? ` · ${r.releasePolicy.replace(/_/g, " ").toLowerCase()}` : ""}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <a href={r.fileUrl} target="_blank" rel="noreferrer" className="text-[var(--color-primary)] hover:underline">
                  View
                </a>
                <button
                  type="button"
                  onClick={() => handleDelete(r.id)}
                  disabled={deletingId === r.id}
                  className="text-[var(--color-error)] hover:underline disabled:opacity-50"
                >
                  {deletingId === r.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
