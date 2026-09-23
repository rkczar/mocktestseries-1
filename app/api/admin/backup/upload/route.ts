import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { ensureManagedDirs, listArtifacts, verifyArtifact } from "@/lib/backup/discovery";
import { createPrivateWriteStream } from "@/lib/backup/package";
import { logBackupAudit } from "@/lib/backup/audit";

export const dynamic = "force-dynamic";

/**
 * Upload a package from the administrator's device for verification/restore.
 * Streams the raw body (no buffering) into <managed>/incoming under a
 * server-generated name, then verifies it. nginx limits bodies to 20 MB here;
 * larger packages are copied to the VPS incoming folder by SCP instead
 * (they then appear in VPS Backups automatically).
 */
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request) {
  let adminId: string | undefined;
  try {
    adminId = (await requirePermission(PERMISSIONS.BACKUP_MANAGE)).user.id;
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!req.body || len <= 0 || len > MAX_BYTES) return NextResponse.json({ error: "Upload must be a backup .tar up to 20 MB (copy larger ones into the VPS incoming folder)." }, { status: 413 });
  const roots = PRODUCTION_ROOTS;
  await ensureManagedDirs(roots);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const name = `upload-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${crypto.randomBytes(3).toString("hex")}.tar`;
  const partial = path.join(roots.incoming, `.${name}.part`);
  let received = 0;
  try {
    const source = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream<Uint8Array>);
    source.on("data", (c: Buffer) => {
      received += c.length;
      if (received > MAX_BYTES) source.destroy(new Error("too large"));
    });
    await pipeline(source, createPrivateWriteStream(partial));
    await rename(partial, path.join(roots.incoming, name));
  } catch {
    await rm(partial, { force: true });
    return NextResponse.json({ error: "Upload failed or exceeded 20 MB." }, { status: 400 });
  }
  const artifact = (await listArtifacts(roots)).find((a) => a.name === name);
  const report = artifact ? await verifyArtifact(roots, artifact.id) : null;
  await logBackupAudit(adminId, "BACKUP_UPLOADED", "BackupArtifact", artifact?.id ?? null, { name, bytes: received, status: report?.status ?? null });
  return NextResponse.json({ id: artifact?.id ?? null, name, status: report?.status ?? null, summary: report?.summary ?? null });
}
