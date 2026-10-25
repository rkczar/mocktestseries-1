import { getVideoSettings } from "@/lib/video-studio/settings";
import { MotionStyleGallery } from "@/components/admin/video-studio/motion/style-gallery";

export const dynamic = "force-dynamic";

export default async function MotionStylesPage() {
  const settings = await getVideoSettings();
  return <MotionStyleGallery wordmark={settings.brand.wordmark} />;
}
