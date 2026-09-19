import { Suspense } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDistanceToNow } from "date-fns";
import type { Prisma } from "@prisma/client";

async function ImportHistoryContent({ page, q }: { page: number; q: string }) {
  const limit = 20;
  const skip = (page - 1) * limit;

  const where: Prisma.BulkImportRunWhereInput = q
    ? {
        OR: [
          { id: { equals: q } },
          { filename: { contains: q, mode: "insensitive" } },
          { label: { contains: q, mode: "insensitive" } },
          { exam: { name: { contains: q, mode: "insensitive" } } },
        ],
      }
    : {};

  const [runs, total] = await Promise.all([
    prisma.bulkImportRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        adminUser: { select: { name: true, username: true } },
        exam: { select: { name: true } },
      },
    }),
    prisma.bulkImportRun.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  const STATUS_VARIANT = {
    PENDING: "neutral" as const,
    UPLOADED: "neutral" as const,
    VALIDATING: "warning" as const,
    READY: "neutral" as const,
    PROCESSING: "warning" as const,
    COMPLETED: "success" as const,
    IMPORTED: "success" as const,
    FAILED: "error" as const,
    PARTIALLY_COMPLETED: "warning" as const,
    PARTIALLY_IMPORTED: "warning" as const,
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Import Runs</CardTitle>
              <CardDescription>{total} total runs</CardDescription>
            </div>
            <form className="flex gap-2" action="/admin/questions/bulk-import/history">
              <Input name="q" defaultValue={q} placeholder="Search batch, filename, or exam..." className="w-64" />
              <Button type="submit" variant="outline" size="sm">Search</Button>
            </form>
          </div>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No import runs {q ? "match your search" : "yet"}.{" "}
              <Link href="/admin/questions/bulk-import" className="text-[var(--color-primary)] hover:underline">
                Start a new import
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-4">Batch</th>
                    <th className="py-2 pr-4">File</th>
                    <th className="py-2 pr-4">Exam / Year</th>
                    <th className="py-2 pr-4">User</th>
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Warnings</th>
                    <th className="py-2 pr-4">Drafts</th>
                    <th className="py-2 pr-4">Review</th>
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
                      <td className="py-2.5 pr-4">
                        <div className="font-medium">{run.label || <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{run.id.slice(0, 8)}</span>}</div>
                        {run.format && <Badge variant="neutral">{run.format}</Badge>}
                      </td>
                      <td className="py-2.5 pr-4 max-w-xs truncate">{run.filename}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        {run.exam ? `${run.exam.name}${run.examYear ? ` ${run.examYear}` : ""}` : "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{run.adminUser.name}</td>
                      <td className="py-2.5 pr-4">{run.totalRows}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-warning)]">{run.warningRows}</td>
                      <td className="py-2.5 pr-4">{run.draftCount}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-warning)]">{run.reviewRequiredCount}</td>
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
                    <Link href={`/admin/questions/bulk-import/history?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>Previous</Link>
                  </Button>
                )}
                {page < totalPages && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/questions/bulk-import/history?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>Next</Link>
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

export default async function ImportHistoryPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const { page: pageParam, q: qParam } = await searchParams;
  const page = parseInt(pageParam || "1", 10);
  const q = (qParam || "").trim();

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ImportHistoryContent page={page} q={q} />
    </Suspense>
  );
}
