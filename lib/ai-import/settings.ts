import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { IMPORTER_SETTING_KEY, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";

export async function getImporterSettings(): Promise<ImporterSettings & { updatedAt: string | null }> {
  const row = await prisma.setting.findUnique({ where: { key: IMPORTER_SETTING_KEY } });
  const raw = (row?.value ?? {}) as Record<string, unknown>;
  return { ...normalizeImporterSettings(raw), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
}

/** Replaces the whole (normalized) settings document. `db` = a transaction when it must be saved together with other changes. */
export async function saveImporterSettings(next: ImporterSettings, actorId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<ImporterSettings> {
  const normalized = normalizeImporterSettings(next);
  const value = JSON.stringify({ ...normalized, updatedAt: new Date().toISOString(), updatedById: actorId });
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${IMPORTER_SETTING_KEY}, ${value}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ${value}::jsonb, "updatedAt" = now()`);
  await db.auditLog.create({
    data: { actorId, action: "AI_IMPORTER_SETTINGS_SAVED", entityType: "Setting", entityId: IMPORTER_SETTING_KEY, metadata: normalized as unknown as Prisma.InputJsonValue },
  });
  return normalized;
}
