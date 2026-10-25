import { RestrictedCard } from "@/components/admin/restricted-card";
import { VideoStudioSubnav } from "@/components/admin/video-studio/subnav";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * Admin → AI Video Studio. Pages need VIDEO_STUDIO_VIEW (MASTER_ADMIN +
 * FULL_ADMIN, read only); every action re-checks VIDEO_STUDIO_USE / MANAGE
 * (MASTER_ADMIN) server-side. Nothing is published from here: finished
 * videos are downloaded.
 */
export default async function VideoStudioLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasPermission(PERMISSIONS.VIDEO_STUDIO_VIEW))) return <RestrictedCard title="AI Video Studio" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Video Studio</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Educational videos and Reels from topics and Question Bank questions — Hindi, Hinglish and English. Every paid step shows its estimated price first and starts only after you confirm.
        </p>
      </div>
      <VideoStudioSubnav />
      {children}
    </div>
  );
}
