import { NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { completeJobDownload, openJobPackage } from "@/lib/backup/jobs";
import { sha256File } from "@/lib/backup/exec";
import { downloadResponse } from "@/lib/backup/stream";

export const dynamic = "force-dynamic";

/**
 * Streams a generated package after checking it still hashes to the SHA-256 recorded when it was verified.
 * The package stays on the VPS: the download can be repeated, and an interrupted one resumed (Range / If-Range).
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
  if (!/^[a-z0-9]{20,32}$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const pkg = await openJobPackage(PRODUCTION_ROOTS, id);
  if (!pkg) return NextResponse.json({ error: "This backup is no longer available for download." }, { status: 404 });
  if (!pkg.sha256 || (await sha256File(pkg.file)) !== pkg.sha256)
    return NextResponse.json({ error: "This backup failed its integrity check (SHA-256 differs from the verified file), so it was not sent." }, { status: 409 });
  return downloadResponse(req, pkg.file, pkg.fileName, pkg.size, pkg.sha256, () => completeJobDownload(PRODUCTION_ROOTS, id, adminId));
}
