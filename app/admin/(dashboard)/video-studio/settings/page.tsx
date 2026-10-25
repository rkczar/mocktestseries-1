import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { freeDiskBytes, listJobFolders, videoRoot } from "@/lib/video-studio/storage";
import { VideoSettingsForm } from "@/components/admin/video-studio/settings-form";
import { getVoiceCatalog } from "@/lib/video-studio/voices";

export const dynamic = "force-dynamic";

export default async function VideoSettingsPage() {
  const [settings, canManage, free, folders, holding, catalog] = await Promise.all([
    getVideoSettings(),
    hasPermission(PERMISSIONS.VIDEO_STUDIO_MANAGE),
    freeDiskBytes().catch(() => null),
    listJobFolders().catch(() => []),
    prisma.videoJob.aggregate({ where: { mediaDeletedAt: null }, _sum: { storageBytes: true } }),
    getVoiceCatalog(),
  ]);
  return (
    <VideoSettingsForm
      settings={settings}
      canManage={canManage}
      sttModels={catalog.sttModels.map((m) => ({ id: m.id, name: m.name, perSecondUsd: m.perSecondUsd }))}
      storage={{ root: videoRoot(), freeGb: free === null ? null : free / 1024 ** 3, folders: folders.length, strayEntries: folders.filter((f) => !f.valid).length, mediaMb: Number(holding._sum.storageBytes ?? 0) / 1024 ** 2 }}
    />
  );
}
