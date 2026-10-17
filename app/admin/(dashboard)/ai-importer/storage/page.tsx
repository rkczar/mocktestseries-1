import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/ai-import/config";
import { CLEANUP_CATEGORIES } from "@/lib/ai-import/storage";
import { StorageManager } from "./storage-manager";

export const metadata = { title: "Import Storage Manager — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Storage Manager: scan, preview and clean
 * the importer's own storage. Nothing is deleted without a preview and a
 * typed confirmation; referenced question images are never deletable here.
 */
export default async function StoragePage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Import Storage Manager" />;
  const canManage = await hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE);
  const history = await prisma.aiImportCleanup.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Import Storage Manager</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Finds temporary files, page renders, unreferenced figure copies, expired originals and leftover import packages. Every delete is re-checked against the database at the moment it runs. Images used by questions, options, explanations or past attempts are never deleted.
        </p>
      </div>
      {canManage ? (
        <StorageManager categories={Object.entries(CLEANUP_CATEGORIES).map(([key, label]) => ({ key, label }))} />
      ) : (
        <Card>
          <CardContent className="py-4 text-sm text-[var(--color-muted-foreground)]">Only a Master Admin can scan and clean storage.</CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Cleanup history</CardTitle>
          <CardDescription>Every cleanup, manual or automatic.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm" data-testid="cleanup-history">
            {history.map((h) => (
              <li key={h.id}>
                {formatIst(h.createdAt)} · {(h.detail as { automatic?: boolean }).automatic ? "automatic" : "manual"} · {h.fileCount} item(s) · {formatBytes(h.bytes)} · {h.categories.map((c) => (CLEANUP_CATEGORIES as Record<string, string>)[c]?.split(" (")[0] ?? c).join(", ")}
                {((h.detail as { skipped?: unknown[] }).skipped?.length ?? 0) > 0 ? ` · ${(h.detail as { skipped: unknown[] }).skipped.length} skipped` : ""}
              </li>
            ))}
            {!history.length && <li className="text-[var(--color-muted-foreground)]">No cleanups yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
