import { getStudioSettings } from "@/lib/instagram/config";
import { prisma } from "@/lib/prisma";
import { StudioSettingsForm } from "@/components/admin/instagram/settings-form";

export const metadata = { title: "Settings — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Settings (stored in Setting `instagram.studio`; empty fields fall back to the live website values). */
export default async function InstagramSettingsPage() {
  const [settings, exams, stored] = await Promise.all([
    getStudioSettings(),
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.setting.findUnique({ where: { key: "instagram.studio" } }),
  ]);
  return <StudioSettingsForm settings={settings} stored={(stored?.value ?? {}) as Record<string, unknown>} exams={exams} />;
}
