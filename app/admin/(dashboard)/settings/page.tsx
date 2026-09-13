import Link from "next/link";
import { Lock } from "lucide-react";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import GeneralSettingsPage from "./general/page";
import ApiManagementPage from "./authentication/page";
import NotificationsPage from "./notifications/page";

export const metadata = { title: "Settings — Mock Test Series.in Admin" };

function SecurityCrossLink() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>Security settings now live in their own module.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">
          Authentication monitoring and security policy configuration have moved to the dedicated Security
          module to avoid duplicating the same settings in two places.
        </p>
        <Link
          href="/admin/security"
          className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]"
        >
          <Lock className="h-4 w-4" aria-hidden />
          Go to Security
        </Link>
      </CardContent>
    </Card>
  );
}

export default function SettingsControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          General settings, API management, and notifications.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="general"
        tabs={[
          { value: "general", label: "General", content: <GeneralSettingsPage /> },
          { value: "authentication", label: "Authentication", content: <ApiManagementPage /> },
          { value: "notifications", label: "Notifications", content: <NotificationsPage /> },
          { value: "security", label: "Security", content: <SecurityCrossLink /> },
        ]}
      />
    </div>
  );
}
