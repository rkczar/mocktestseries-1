import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importerModelCatalog } from "@/lib/ai-import/models";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "Import Settings — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Import Settings (Master Admin). Models come
 * from the synced OpenRouter catalog (Admin → AI → Models); only APPROVED,
 * priced models can be chosen. Nothing here spends money by itself and no key
 * (or part of one) is ever sent to the browser.
 */
export default async function ImportSettingsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Import Settings" />;
  const [settings, canManage, catalog] = await Promise.all([getImporterSettings(), hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE), importerModelCatalog()]);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Import Settings</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Paid AI, models, privacy and budgets of the AI Question Importer. The importer has its own budgets, separate from student Ask AI; every limit here is enforced by the server before each AI request.
        </p>
      </div>
      {!canManage && (
        <Card>
          <CardContent className="py-3 text-sm text-[var(--color-muted-foreground)]">Read-only: only a Master Admin can change these settings.</CardContent>
        </Card>
      )}
      <SettingsForm initial={settings} catalog={catalog} canManage={canManage} />
    </div>
  );
}
