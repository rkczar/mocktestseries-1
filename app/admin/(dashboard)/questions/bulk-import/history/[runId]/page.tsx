import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

async function ImportDetailsContent({ runId, page }: { runId: string; page: number }) {
  const limit = 50;
  const skip = (page - 1) * limit;

  const run = await prisma.bulkImportRun.findUnique({
    where: { id: runId },
    include: {
      adminUser: {
        select: { name: true, username: true },
      },
    },
  });

  if (!run) {
    notFound();
  }

  const [rows, total] = await Promise.all([
    prisma.bulkImportRow.findMany({
      where: { runId },
      orderBy: { rowNumber: "asc" },
      skip,
      take: limit,
    }),
    prisma.bulkImportRow.count({ where: { runId } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  const STATUS_VARIANT = {
    PENDING: "neutral" as const,
    SUCCESS: "success" as const,
    SKIPPED: "warning" as const,
    REPLACED: "primary" as const,
    FAILED: "error" as const,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/admin/questions/bulk-import/history">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Import Run Details</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Run #{run.id.slice(0, 8)} • {formatDistanceToNow(run.createdAt, { addSuffix: true })}
          </p>
        </div>
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
              <span className="text-sm text-[var(--color-muted-foreground)]">Imported by:</span>
              <span className="text-sm font-medium">{run.adminUser.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Strategy:</span>
              <span className="text-sm font-medium">{run.duplicateStrategy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-[var(--color-muted-foreground)]">Status:</span>
              <Badge variant={run.status === "COMPLETED" ? "success" : run.status === "FAILED" ? "error" : "warning"}>
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
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-2xl font-bold text-[var(--color-foreground)]">{run.totalRows}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">Total Rows</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-2xl font-bold text-[var(--color-success)]">{run.successCount}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">Created</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-2xl font-bold text-[var(--color-warning)]">{run.skippedCount}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">Skipped</div>
              </div>
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-2xl font-bold text-[var(--color-error)]">{run.failedCount}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">Failed</div>
              </div>
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
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Row</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Question Code</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4">{row.rowNumber}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      {row.questionCode ? (
                        <span className="font-mono text-xs">{row.questionCode}</span>
                      ) : (
                        <span className="text-[var(--color-muted-foreground)]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 max-w-md truncate">
                      {(row.rawData as any)?.questionText || "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-error)]">
                      {row.errorMessage || "—"}
                    </td>
                  </tr>
                ))}
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
