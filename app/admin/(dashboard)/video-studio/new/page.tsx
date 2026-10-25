import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { DESIGN_MAP } from "@/lib/video-studio/designs";
import { NewVideoForm } from "@/components/admin/video-studio/new-video-form";

export const dynamic = "force-dynamic";

export default async function NewVideoPage({ searchParams }: { searchParams: Promise<{ design?: string }> }) {
  if (!(await hasPermission(PERMISSIONS.VIDEO_STUDIO_USE))) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Read-only access: only a Master Admin can create videos.</p>;
  }
  const exams = await prisma.exam.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } });
  const { design } = await searchParams;
  const designKey = typeof design === "string" && DESIGN_MAP[design]?.status === "ready" ? design : null;
  return <NewVideoForm exams={exams} designKey={designKey} />;
}
