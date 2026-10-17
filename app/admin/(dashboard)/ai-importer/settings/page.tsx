import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsForm, type ModelOption } from "./settings-form";

export const metadata = { title: "Import Settings — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Import Settings (Master Admin). Models come
 * from the APPROVED OpenRouter catalog (Admin → AI → Models); prices are the
 * synced catalog prices. Nothing here spends money by itself.
 */
export default async function ImportSettingsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Import Settings" />;
  const [settings, canManage, models, openrouter] = await Promise.all([
    getImporterSettings(),
    hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE),
    prisma.aiModel.findMany({ where: { approved: true, disabled: false, missingSince: null }, orderBy: { promptPrice: "asc" }, select: { id: true, name: true, inputModalities: true, promptPrice: true, completionPrice: true, contextLength: true, lastSyncedAt: true } }),
    getOpenRouterConfig(),
  ]);
  const options: ModelOption[] = models.map((m) => ({ id: m.id, name: m.name, vision: m.inputModalities.includes("image"), promptPerM: m.promptPrice !== null ? m.promptPrice * 1e6 : null, completionPerM: m.completionPrice !== null ? m.completionPrice * 1e6 : null, context: m.contextLength, synced: m.lastSyncedAt.toISOString().slice(0, 10) }));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Import Settings</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Only models approved in <Link className="underline" href="/admin/ai/models">AI → Models</Link> can be chosen. OpenRouter: {openrouter.enabled ? "enabled" : "disabled"}{openrouter.keyHint ? ` (key ${openrouter.keyHint})` : " (no key)"}. The importer has its own monthly budget, separate from student Ask AI.
        </p>
      </div>
      {!canManage && (
        <Card>
          <CardContent className="py-3 text-sm text-[var(--color-muted-foreground)]">Read-only: only a Master Admin can change these settings.</CardContent>
        </Card>
      )}
      <SettingsForm initial={settings} models={options} canManage={canManage} />
    </div>
  );
}
