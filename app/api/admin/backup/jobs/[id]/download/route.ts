import { NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { completeJobDownload, openJobPackage } from "@/lib/backup/jobs";
import { downloadHeaders, fileDownloadStream } from "@/lib/backup/stream";

export const dynamic = "force-dynamic";

/** Streams a freshly generated package; download-only packages are deleted from the VPS once fully sent. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  return new NextResponse(fileDownloadStream(pkg.file, () => completeJobDownload(PRODUCTION_ROOTS, id, adminId)), { headers: downloadHeaders(pkg.fileName, pkg.size) });
}
