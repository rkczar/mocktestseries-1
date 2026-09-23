import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { resolveArtifact } from "@/lib/backup/discovery";
import { downloadHeaders, fileDownloadStream } from "@/lib/backup/stream";
import { logBackupAudit } from "@/lib/backup/audit";

export const dynamic = "force-dynamic";

/** Streams an existing VPS backup by opaque id only (allowlisted roots, no traversal/symlink escape). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let adminId: string | undefined;
  try {
    adminId = (await requirePermission(PERMISSIONS.BACKUP_MANAGE)).user.id;
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const { id } = await params;
  const resolved = await resolveArtifact(PRODUCTION_ROOTS, id).catch(() => null);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const size = (await stat(resolved.file)).size;
  await logBackupAudit(adminId, "BACKUP_DOWNLOADED", "BackupArtifact", id, { name: resolved.artifact.name, bytes: size });
  return new NextResponse(fileDownloadStream(resolved.file), { headers: downloadHeaders(resolved.artifact.name, size) });
}
