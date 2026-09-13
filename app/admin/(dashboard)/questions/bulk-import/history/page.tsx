import { Suspense } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";

async function ImportHistoryContent({ page }: { page: number }) {
  const limit = 20;
  const skip = (page - 1) * limit;

  const [runs, total] = await Promise.all([
    prisma.bulkImportRun.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        adminUser: {
          select: { name: true, username: true },
        },
      },
    }),
    prisma.bulkImportRun.count(),
  ]);

  const totalPages = Math.ceil(total / limit);

  const STATUS_VARIANT = {
    PENDING: "neutral" as const,
    PROCESSING: "warning" as const,
    COMPLETED: "success" as const,
    FAILED: "error" as const,
    PARTIALLY_COMPLETED: "warning" as const,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Import History</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            View past bulk import runs and their results.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/questions/bulk-import">New Import</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Import Runs</CardTitle>
          <CardDescription>{total} total runs</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No import runs yet. Start by{" "}
              <Link href="/admin/questions/bulk-import" className="text-[var(--color-primary)] hover:underline">
                importing questions
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-4">Run ID</th>
                    <th className="py-2 pr-4">File</th>
                    <th className="py-2 pr-4">User</th>
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Success</th>
                    <th className="py-2 pr-4">Failed</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">
                        {run.id.slice(0, 8)}
                      </td>
                      <td className="py-2.5 pr-4 max-w-xs truncate">{run.filename}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{run.adminUser.name}</td>
                      <td className="py-2.5 pr-4">{run.totalRows}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-success)]">{run.successCount}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-error)]">{run.failedCount}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        {formatDistanceToNow(run.createdAt, { addSuffix: true })}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/admin/questions/bulk-import/history/${run.id}`}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--color-border)]">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                {page > 1 && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/questions/bulk-import/history?page=${page - 1}`}>Previous</Link>
                  </Button>
                )}
                {page < totalPages && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/questions/bulk-import/history?page=${page + 1}`}>Next</Link>
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

export default async function ImportHistoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = parseInt(pageParam || "1", 10);

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ImportHistoryContent page={page} />
    </Suspense>
  );
}
