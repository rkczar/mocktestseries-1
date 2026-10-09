import { getStudioSettings } from "@/lib/instagram/config";
import { getConnectionConfigView, getLastConnectionResult } from "@/lib/instagram/meta";
import { prisma } from "@/lib/prisma";
import { StudioSettingsForm } from "@/components/admin/instagram/settings-form";
import { ConnectionCard } from "@/components/admin/instagram/connection-card";

export const metadata = { title: "Settings — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Settings (stored in Setting `instagram.studio`; empty fields fall back to the live website values). */
export default async function InstagramSettingsPage() {
  const [settings, exams, stored, lastConnection] = await Promise.all([
    getStudioSettings(),
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.setting.findUnique({ where: { key: "instagram.studio" } }),
    getLastConnectionResult(),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <ConnectionCard config={getConnectionConfigView()} last={lastConnection} />
      <StudioSettingsForm settings={settings} stored={(stored?.value ?? {}) as Record<string, unknown>} exams={exams} />
    </div>
  );
}
