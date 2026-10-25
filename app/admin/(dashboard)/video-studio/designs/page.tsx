import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { DesignGallery } from "@/components/admin/video-studio/design-gallery";

export const dynamic = "force-dynamic";

export default async function DesignsPage() {
  const [s, canUse] = await Promise.all([getVideoSettings(), hasPermission(PERMISSIONS.VIDEO_STUDIO_USE)]);
  return <DesignGallery wordmark={s.brand.wordmark} canUse={canUse} />;
}
