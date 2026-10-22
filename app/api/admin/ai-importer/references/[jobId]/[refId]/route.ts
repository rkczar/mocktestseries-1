import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { readVault } from "@/lib/ai-import/vault";
import { listReferences } from "@/lib/ai-import/reference";

const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv" };

/** The original reference file from the private vault — admins only, never cached. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ jobId: string; refId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { jobId, refId } = await params;
    const ref = (await listReferences(jobId)).find((r) => r.refId === refId);
    if (!ref) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const bytes = await readVault(ref.storageKey);
    const safeName = ref.name.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 120) || "reference";
    return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": MIME[ref.kind] ?? "application/octet-stream", "content-disposition": `attachment; filename="${safeName}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
