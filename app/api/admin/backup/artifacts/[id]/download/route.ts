import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { checkBeforeDownload, resolveArtifact } from "@/lib/backup/discovery";
import { downloadResponse } from "@/lib/backup/stream";
import { logBackupAudit } from "@/lib/backup/audit";

export const dynamic = "force-dynamic";

/**
 * Streams an existing VPS backup by opaque id only (allowlisted roots, no traversal/symlink escape), after an
 * integrity check; never deletes it. Resumable (Range / If-Range on the verified SHA-256).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const integrity = await checkBeforeDownload(PRODUCTION_ROOTS, resolved.artifact, resolved.file);
  if (!integrity.ok) return NextResponse.json({ error: integrity.reason }, { status: 409 });
  const size = (await stat(resolved.file)).size;
  const name = resolved.artifact.name;
  return downloadResponse(req, resolved.file, name, size, integrity.sha256, () => logBackupAudit(adminId, "BACKUP_DOWNLOADED", "BackupArtifact", id, { name, bytes: size, sha256: integrity.sha256 }));
}
