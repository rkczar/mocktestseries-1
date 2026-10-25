import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { NewMotionForm } from "@/components/admin/video-studio/motion/new-motion-form";

export const dynamic = "force-dynamic";

export default async function NewMotionPage() {
  if (!(await hasPermission(PERMISSIONS.VIDEO_STUDIO_USE))) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Read-only access: only a Master Admin can create videos.</p>;
  }
  const [exams, settings] = await Promise.all([prisma.exam.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }), getVideoSettings()]);
  return <NewMotionForm exams={exams} wordmark={settings.brand.wordmark} />;
}
