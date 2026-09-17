import { getGeminiConfig } from "@/lib/gemini-config";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { GeminiCard } from "./gemini-settings-form";

export const metadata = { title: "AI Settings — Mock Test Series.in Admin" };

export default async function AiSettingsPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="AI Settings" />;
  }

  const gemini = await getGeminiConfig();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Configure the AI provider used by Ask AI explanations and AI-generated question variants.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GeminiCard gemini={gemini} />
      </div>
    </div>
  );
}
