import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { mergeRowData, declaredImageFilenames, matchRowImagesSync, type BulkImportRow as ParsedRowShape } from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";

async function ImportDetailsContent({ runId, page }: { runId: string; page: number }) {
  const limit = 50;
  const skip = (page - 1) * limit;

  const run = await prisma.bulkImportRun.findUnique({
    where: { id: runId },
    include: {
      adminUser: { select: { name: true, username: true } },
      exam: { select: { name: true } },
      previousYearPaper: { select: { title: true } },
      mockTest: { select: { id: true, title: true, order: true } },
    },
  });

  if (!run) {
    notFound();
  }

  const [rows, total, imageIndex] = await Promise.all([
    prisma.bulkImportRow.findMany({
      where: { runId },
      orderBy: { rowNumber: "asc" },
      skip,
      take: limit,
    }),
    prisma.bulkImportRow.count({ where: { runId } }),
    getImageFilenameIndex(),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  const STATUS_VARIANT = {
    PENDING: "neutral" as const,
    SUCCESS: "success" as const,
    SKIPPED: "warning" as const,
    REPLACED: "primary" as const,
    FAILED: "error" as const,
  };
  const SEVERITY_VARIANT = { VALID: "success" as const, WARNING: "warning" as const, ERROR: "error" as const };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/admin/questions/bulk-import/history">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-[var(--color-foreground)]">{run.label || "Import Run Details"}</h1>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
              Run #{run.id.slice(0, 8)} • {formatDistanceToNow(run.createdAt, { addSuffix: true })}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/admin/questions/bulk-import/runs/${runId}/error-report`}>
            <Download className="h-4 w-4 mr-1" />
            Error Report
          </a>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Run Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">File:</span>
              <span className="text-sm font-medium">{run.filename}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Format:</span>
              <span className="text-sm font-medium">{run.format ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Exam / Year:</span>
              <span className="text-sm font-medium">{run.exam ? `${run.exam.name}${run.examYear ? ` ${run.examYear}` : ""}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Import source:</span>
              <span className="text-sm font-medium">{run.importSource === "MOCK_TEST" ? "Mock Test" : "Question Bank"}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-sm text-[var(--color-muted-foreground)]">Target:</span>
              <span className="text-right text-sm font-medium">
                {run.mockTest ? (
                  <Link href={`/admin/tests/mock/${run.mockTest.id}#questions`} className="text-[var(--color-primary)] hover:underline">
                    Mock {run.mockTest.order}: {run.mockTest.title}
                  </Link>
                ) : run.previousYearPaper ? (
                  `Previous Year Paper: ${run.previousYearPaper.title}`
                ) : (
                  "Question Bank only"
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Imported by:</span>
              <span className="text-sm font-medium">{run.adminUser.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Strategy:</span>
              <span className="text-sm font-medium">{run.duplicateStrategy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Imported at:</span>
              <span className="text-sm font-medium">{run.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Status:</span>
              <Badge variant={run.status === "IMPORTED" || run.status === "COMPLETED" ? "success" : run.status === "FAILED" ? "error" : "warning"}>
                {run.status}
              </Badge>
            </div>
            {run.completedAt && (
              <div className="flex justify-between">
                <span className="text-sm text-[var(--color-muted-foreground)]">Duration:</span>
                <span className="text-sm font-medium">
                  {Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)}s
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Total Rows" value={run.totalRows} />
              <Stat label="Warnings" value={run.warningRows} cls="text-[var(--color-warning)]" />
              <Stat label="Review Required" value={run.reviewRequiredCount} cls="text-[var(--color-warning)]" />
              <Stat label="Created" value={run.successCount} cls="text-[var(--color-success)]" />
              <Stat label="Skipped" value={run.skippedCount} cls="text-[var(--color-warning)]" />
              <Stat label="Replaced" value={run.replacedCount} />
              <Stat label="Drafts" value={run.draftCount} />
              <Stat label="Failed" value={run.failedCount} cls="text-[var(--color-error)]" />
              {run.mockTestId ? <Stat label="Attached to Mock Test" value={run.attachedCount} cls="text-[var(--color-success)]" /> : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {run.errorMessage && (
        <Card>
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--color-error)]">{run.errorMessage}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Row Details</CardTitle>
          <CardDescription>
            {total} rows • Page {page} of {totalPages}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Row</th>
                  <th className="py-2 pr-4">Outcome</th>
                  <th className="py-2 pr-4">Validation</th>
                  <th className="py-2 pr-4">Question Code</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Images</th>
                  <th className="py-2 pr-4">Errors / Warnings</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
                  const declared = declaredImageFilenames(merged);
                  const imageMatches = matchRowImagesSync(merged, imageIndex);
                  const errors = (row.errors as string[] | null) ?? [];
                  const warnings = (row.warnings as string[] | null) ?? [];
                  return (
                    <tr key={row.id} className={`border-b border-[var(--color-border)] last:border-0 ${row.removedFromImport ? "opacity-50" : ""}`}>
                      <td className="py-2.5 pr-4">{row.rowNumber}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
                        {row.removedFromImport && <Badge variant="neutral" className="ml-1">Removed</Badge>}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={SEVERITY_VARIANT[row.severity]}>{row.severity}</Badge>
                        {row.reviewRequired && <Badge variant="info" className="ml-1">Review</Badge>}
                      </td>
                      <td className="py-2.5 pr-4">
                        {row.questionCode ? (
                          <span className="font-mono text-xs">{row.questionCode}</span>
                        ) : (
                          <span className="text-[var(--color-muted-foreground)]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 max-w-md truncate">{merged.questionText || "—"}</td>
                      <td className="py-2.5 pr-4">
                        {declared.length === 0 ? (
                          <span className="text-[var(--color-muted-foreground)]">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {imageMatches.map((m) => (
                              <Badge key={m.field} variant={m.status === "FOUND" ? "success" : "warning"}>
                                {m.field}: {m.status}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-xs">
                        {errors.length + warnings.length === 0 ? (
                          <span className="text-[var(--color-muted-foreground)]">{row.errorMessage || "—"}</span>
                        ) : (
                          <ul className="list-disc list-inside">
                            {errors.map((e, i) => (
                              <li key={`e-${i}`} className="text-[var(--color-error)]">{e}</li>
                            ))}
                            {warnings.map((w, i) => (
                              <li key={`w-${i}`} className="text-[var(--color-warning)]">{w}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--color-border)]">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                {page > 1 && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/questions/bulk-import/history/${runId}?page=${page - 1}`}>Previous</Link>
                  </Button>
                )}
                {page < totalPages && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/questions/bulk-import/history/${runId}?page=${page + 1}`}>Next</Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <div className={`text-xl font-bold text-[var(--color-foreground)] ${cls ?? ""}`}>{value}</div>
      <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
    </div>
  );
}

export default async function ImportDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { runId } = await params;
  const { page: pageParam } = await searchParams;
  const page = parseInt(pageParam || "1", 10);

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ImportDetailsContent runId={runId} page={page} />
    </Suspense>
  );
}
