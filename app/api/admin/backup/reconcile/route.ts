import { NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { listReleases } from "@/lib/backup/releases";
import { listArtifacts } from "@/lib/backup/discovery";

export const dynamic = "force-dynamic";

/**
 * Read-only reconciliation after an ambiguous Backup Center result (network
 * error / proxy timeout): does this release or backup still exist? A Route
 * Handler rather than a Server Action on purpose — Server Actions are
 * dispatched one at a time per client, so this check must not queue behind
 * the very request whose outcome is unknown. Never deletes anything.
 */
export async function GET(req: Request) {
  try {
    await requirePermission(PERMISSIONS.BACKUP_VIEW);
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind");
  const id = u.searchParams.get("id") ?? "";
  if ((kind !== "release" && kind !== "backup") || !/^[0-9a-f]{32}$/.test(id)) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  const exists =
    kind === "release"
      ? (await listReleases(PRODUCTION_ROOTS, { includePm2: false })).releases.some((r) => r.id === id)
      : (await listArtifacts(PRODUCTION_ROOTS)).some((a) => a.id === id);
  return NextResponse.json({ ok: true, data: { exists } }, { headers: { "Cache-Control": "no-store" } });
}
