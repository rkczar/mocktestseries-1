import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { AiOverview } from "@/components/admin/ai/ai-overview";
import SolutionsPage from "./solutions/page";
import VariantsPage from "./variants/page";
import UsagePage from "./usage/page";
import SettingsPage from "./settings/page";
import ProvidersPage from "./providers/page";
import { AiEngineOverview } from "@/components/admin/ai/engine-overview";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export const metadata = { title: "AI Solutions — Mock Test Series.in Admin" };

export const dynamic = "force-dynamic";

export default async function AiControlCenter() {
  const canViewEngine = await hasPermission(PERMISSIONS.AI_ENGINE_VIEW);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Solutions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Overview, AI providers, solutions, question variants, usage, and settings.
        </p>
      </div>

      {canViewEngine ? <AiEngineOverview /> : null}

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <AiOverview /> },
          { value: "providers", label: "AI Providers", content: <ProvidersPage /> },
          { value: "solutions", label: "Solutions", content: <SolutionsPage /> },
          { value: "variants", label: "Variants", content: <VariantsPage /> },
          { value: "usage", label: "Usage", content: <UsagePage /> },
          { value: "settings", label: "Settings", content: <SettingsPage /> },
        ]}
      />
    </div>
  );
}
