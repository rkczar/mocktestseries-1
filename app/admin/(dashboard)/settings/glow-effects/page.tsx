import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getPremiumGlowConfig } from "@/lib/premium-glow-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GlowEffectsForm } from "./glow-effects-form";

export const metadata = { title: "Glow Effects — Mock Test Series.in Admin" };

export default async function GlowEffectsPage() {
  const [session, config] = await Promise.all([getAdminSession(), getPremiumGlowConfig()]);
  const canManage = !!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Glow Effects</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The breathing glow on selected student buttons. This changes appearance only — every button keeps working
          exactly the same with its glow off.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Premium Glow</CardTitle>
          <CardDescription>
            {canManage
              ? "Saved changes reach every student within a few seconds, no deployment required."
              : "View only — only a Master Admin can change glow effects."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GlowEffectsForm initial={config} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  );
}
