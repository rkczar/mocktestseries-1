import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import AuthenticationMonitoringPage from "../monitoring/authentication/page";
import SecuritySettingsPage from "../settings/security/page";

export const metadata = { title: "Security — Mock Test Series.in Admin" };

export default function SecurityControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Security</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Authentication monitoring and platform security settings.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="authentication"
        tabs={[
          {
            value: "authentication",
            label: "Authentication Monitoring",
            content: <AuthenticationMonitoringPage />,
          },
          { value: "settings", label: "Security Settings", content: <SecuritySettingsPage /> },
        ]}
      />
    </div>
  );
}
