import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getVoiceCatalog } from "@/lib/video-studio/voices";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { VoiceStudio } from "@/components/admin/video-studio/voice-studio";

export const dynamic = "force-dynamic";

export default async function VoicesPage() {
  const [catalog, canManage, fx] = await Promise.all([getVoiceCatalog(), hasPermission(PERMISSIONS.VIDEO_STUDIO_MANAGE), getUsdInr()]);
  return <VoiceStudio catalog={catalog} canManage={canManage} fxRate={fx.rate} />;
}
