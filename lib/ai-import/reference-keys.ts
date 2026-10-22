import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Vault keys held by reference papers (REFERENCE_ADDED events). A reference shares the content-addressed
 * files/ area with question papers, so removing a paper or deleting a job must never delete bytes a
 * reference still points at. `exceptJobId`: references of that job are not counted.
 */
export async function referenceKeysInUse(db: Prisma.TransactionClient | typeof prisma, keys: string[], exceptJobId?: string): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.aiImportEvent.findMany({ where: { type: "REFERENCE_ADDED", ...(exceptJobId ? { jobId: { not: exceptJobId } } : {}) }, select: { data: true } });
  const wanted = new Set(keys);
  const out = new Set<string>();
  for (const r of rows) {
    const k = (r.data as { storageKey?: unknown } | null)?.storageKey;
    if (typeof k === "string" && wanted.has(k)) out.add(k);
  }
  return out;
}
