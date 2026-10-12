import { getAppearance } from "@/lib/appearance";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getBackgroundEffectsConfig } from "@/lib/background-effects-settings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AppearanceForm } from "./appearance-form";
import { BackgroundEffectsForm } from "./background-effects-form";

export const metadata = { title: "Appearance — Mock Test Series.in Admin" };

export default async function AppearancePage() {
  const [appearance, backgroundEffects, session] = await Promise.all([getAppearance(), getBackgroundEffectsConfig(), getAdminSession()]);
  const canManageBackground = !!session?.user?.permissions?.includes(PERMISSIONS.WEBSITE_MANAGE);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Appearance</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Controls the global design system used across the public website, student experience, and this Admin
          Panel. Day / Night / Eye-Saver mode is a separate per-viewer toggle in the header — this page sets the
          brand tokens underneath all three.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Design Tokens</CardTitle>
          <CardDescription>Changes apply immediately, no deployment required.</CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceForm appearance={appearance} />
        </CardContent>
      </Card>

      <Card id="background-effects">
        <CardHeader>
          <CardTitle>Background Effects</CardTitle>
          <CardDescription>
            {canManageBackground
              ? "Decorative backgrounds behind the homepage, public pages or Student Dashboard. Nothing changes on the website until you save."
              : "View only — only a Master Admin can change background effects."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BackgroundEffectsForm initial={backgroundEffects} canManage={canManageBackground} />
        </CardContent>
      </Card>
    </div>
  );
}
