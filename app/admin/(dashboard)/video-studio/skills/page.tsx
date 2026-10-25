import { prisma } from "@/lib/prisma";
import { getAdminSession, hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { SkillLibrary } from "@/components/admin/video-studio/skill-library";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const [session, canUse] = await Promise.all([getAdminSession(), hasPermission(PERMISSIONS.VIDEO_STUDIO_USE)]);
  const presets = session?.user?.id
    ? await prisma.videoSkillPreset.findMany({ where: { createdById: session.user.id }, orderBy: [{ favorite: "desc" }, { updatedAt: "desc" }], select: { id: true, name: true, skillKeys: true, instructions: true, favorite: true } })
    : [];
  return <SkillLibrary presets={presets} canUse={canUse} />;
}
