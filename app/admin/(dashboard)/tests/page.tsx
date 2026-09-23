import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import BuilderPage from "./builder/page";
import MockTestsPage from "./mock/page";
import CustomModulesPage from "../custom-modules/page";
import GrandTestsPage from "./grand/page";
import CustomTestsPage from "./custom/page";
import RandomTestsPage from "./random/page";
import LiveTestsPage from "./live/page";
import ScheduledTestsPage from "./scheduled/page";

export const metadata = { title: "Tests — Mock Test Series.in Admin" };

function AllTestsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tests</CardTitle>
        <CardDescription>Mock tests, custom modules, random and live tests, and scheduling.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Use the tabs above to create a test (Test Builder), manage Mock Tests and Custom Modules — the two
          live test types students can take — or check on Random, Live, and Scheduled tests as they come
          online.
        </p>
      </CardContent>
    </Card>
  );
}

export default function TestsControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Test builder, mock tests, custom modules, random, live, and scheduled tests.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="all"
        tabs={[
          { value: "all", label: "All Tests", content: <AllTestsPanel /> },
          { value: "builder", label: "Create Test", content: <BuilderPage /> },
          { value: "mock", label: "Mock Tests", content: <MockTestsPage searchParams={Promise.resolve({})} /> },
          { value: "custom-modules", label: "Custom Modules", content: <CustomModulesPage /> },
          { value: "grand", label: "Grand Tests", content: <GrandTestsPage /> },
          { value: "custom", label: "Custom Tests", content: <CustomTestsPage /> },
          { value: "random", label: "Random Tests", content: <RandomTestsPage /> },
          { value: "live", label: "Live Tests", content: <LiveTestsPage /> },
          { value: "scheduled", label: "Scheduled Tests", content: <ScheduledTestsPage searchParams={Promise.resolve({})} /> },
        ]}
      />
    </div>
  );
}
