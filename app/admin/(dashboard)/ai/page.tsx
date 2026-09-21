import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { AiOverview } from "@/components/admin/ai/ai-overview";
import SolutionsPage from "./solutions/page";
import VariantsPage from "./variants/page";
import UsagePage from "./usage/page";
import SettingsPage from "./settings/page";

export const metadata = { title: "AI Solutions — Mock Test Series.in Admin" };

export default function AiControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Solutions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Overview, solutions, question variants, usage, and settings.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <AiOverview /> },
          { value: "solutions", label: "Solutions", content: <SolutionsPage /> },
          { value: "variants", label: "Variants", content: <VariantsPage /> },
          { value: "usage", label: "Usage", content: <UsagePage /> },
          { value: "settings", label: "Settings", content: <SettingsPage /> },
        ]}
      />
    </div>
  );
}
