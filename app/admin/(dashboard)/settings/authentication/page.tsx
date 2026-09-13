import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { GoogleOAuthCard, Msg91Card, LoginMethodsCard } from "./auth-settings-form";

export const metadata = { title: "Authentication — Mock Test Series.in Admin" };

export default async function AuthenticationSettingsPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="Authentication" />;
  }

  const config = await getAuthProviderConfig();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Authentication</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          API credentials for student sign-in providers. Secrets are encrypted at rest and never shown again after
          saving — only a configured/connected status is displayed here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GoogleOAuthCard google={config.google} />
        <Msg91Card msg91={config.msg91} />
      </div>

      <LoginMethodsCard config={config} />
    </div>
  );
}
