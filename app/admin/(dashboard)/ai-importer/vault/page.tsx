import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { protectedFileIds } from "@/lib/ai-import/source-protection";
import { ExtendRetention } from "./extend-retention";

export const metadata = { title: "Original Paper Vault — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Original Paper Vault: every uploaded paper
 * and answer key, kept privately (never public), with its checksum and
 * retention date. Identical uploads share one stored file.
 */
export default async function VaultPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Original Paper Vault" />;
  const [files, canManage, settings] = await Promise.all([
    prisma.aiImportFile.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { job: { select: { id: true, title: true, status: true } } } }),
    hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE),
    getImporterSettings(),
  ]);
  const protectedIds = await protectedFileIds(prisma, files.filter((f) => f.status !== "PURGED"));
  const now = new Date();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Original Paper Vault</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Originals are never removed automatically. An original that any Question Bank question or its source evidence depends on is kept permanently; others can be reviewed for removal in the Storage Manager {settings.retention.originalDays} days after upload (only when their job is finished). Extend the retention of any paper you need to keep longer.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{files.length} file(s)</CardTitle>
          <CardDescription>Stored outside the website&apos;s public folders; downloads require admin access.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-sm" data-testid="vault-table">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                {["File", "Import", "Type", "Size", "Pages", "SHA-256", "Uploaded", "Keep until", ""].map((h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const expired = f.retainUntil && f.retainUntil < now;
                return (
                  <tr key={f.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2">{f.originalName}</td>
                    <td className="py-1.5 pr-2">
                      <Link className="underline" href={`/admin/ai-importer/jobs/${f.job.id}`}>
                        {f.job.title}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2">{f.role === "PAPER" ? "Question paper" : "Answer key"}</td>
                    <td className="py-1.5 pr-2">{formatBytes(f.bytes || f.declaredBytes)}</td>
                    <td className="py-1.5 pr-2">{f.pageCount ?? "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{f.sha256 ? `${f.sha256.slice(0, 16)}…` : "—"}</td>
                    <td className="py-1.5 pr-2 text-xs">{formatIst(f.createdAt)}</td>
                    <td className="py-1.5 pr-2 text-xs">
                      {f.status === "PURGED" ? <Badge variant="neutral">removed {f.purgedAt ? formatIst(f.purgedAt) : ""}</Badge> : protectedIds.has(f.id) ? (
                        <span title="Question Bank questions or their source evidence depend on this original: it is never removed." data-testid="vault-protected">
                          {f.retainUntil ? formatIst(f.retainUntil) : ""} <Badge variant="success">{expired ? "Expired — protected, retained" : "Protected"}</Badge>
                        </span>
                      ) : f.retainUntil ? <span className={expired ? "text-[var(--color-warning)]" : ""}>{formatIst(f.retainUntil)}{expired ? " (expired)" : ""}</span> : "—"}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {f.storageKey && f.status !== "PURGED" && (
                        <a className="text-xs underline" href={`/api/admin/ai-importer/files/${f.id}/original`}>
                          Download
                        </a>
                      )}
                      {canManage && f.storageKey && f.status !== "PURGED" && <ExtendRetention fileId={f.id} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
