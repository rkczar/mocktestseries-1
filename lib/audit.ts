import "server-only";

import { prisma } from "@/lib/db";

export async function writeAuditLog(params: {
  adminId: string;
  action: "create" | "update" | "delete" | "reorder" | "publish" | "import" | "clear_cache" | "hard_reset";
  entity: string;
  entityId?: string;
  diff?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      adminId: params.adminId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      diff: params.diff === undefined ? undefined : JSON.parse(JSON.stringify(params.diff)),
    },
  });
}
