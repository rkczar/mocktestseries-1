import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import SolutionsPage from "./solutions/page";
import SolutionManagerPage from "./solution-manager/page";
import VariantsPage from "./variants/page";
import UsagePage from "./usage/page";
import SettingsPage from "./settings/page";

export const metadata = { title: "AI Solutions — Mock Test Series.in Admin" };

function AiOverview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Solutions</CardTitle>
        <CardDescription>AI-generated explanations, question variants, and usage tracking.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Gemini AI configuration lives under Settings → Authentication. Generated solutions, question
          variants, and per-model usage/cost reporting will populate here once this module is built out.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AiControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Solutions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Solutions, solution manager, question variants, usage, and settings.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <AiOverview /> },
          { value: "solutions", label: "Solutions", content: <SolutionsPage /> },
          { value: "solution-manager", label: "Solution Manager", content: <SolutionManagerPage /> },
          { value: "variants", label: "Variants", content: <VariantsPage /> },
          { value: "usage", label: "Usage", content: <UsagePage /> },
          { value: "settings", label: "Settings", content: <SettingsPage /> },
        ]}
      />
    </div>
  );
}
