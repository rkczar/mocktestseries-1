import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { mergeRowData } from "@/lib/bulk-import";
import { liveRichViews, type AssetRowLike } from "@/lib/rich-content";
import { allImageRefs, composeQuestionText, fallbackAlt, toManifestQuestion } from "@/lib/rich-import/manifest";
import { loadRichContext } from "@/lib/rich-import/validate";

/**
 * Visual preview of ONE staged RICH row, rendered by the production renderer
 * (lib/rich-content.ts → RichText / QuestionMedia / HumanExplanation on the
 * client) with the bundle's already-processed images. Admin only; shows the
 * answer key and explanation. Nothing is written.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { rowId } = await params;
    const row = await prisma.bulkImportRow.findUnique({ where: { id: rowId } });
    if (!row) return NextResponse.json({ error: "Row not found" }, { status: 404 });
    const ctx = await loadRichContext(row.runId);
    if (!ctx) return NextResponse.json({ error: "Visual preview is available for rich imports only." }, { status: 400 });

    const m = toManifestQuestion(mergeRowData(row.rawData, row.editedData));
    const missing: string[] = [];
    const nextOrder = new Map<string, number>();
    const assets: AssetRowLike[] = [];
    for (const ref of allImageRefs(m)) {
      const hit = (ctx.index.get(ref.filename.toLowerCase()) ?? [])[0];
      if (!hit || hit.status !== "READY" || !hit.storageKey || (ctx.index.get(ref.filename.toLowerCase()) ?? []).length > 1) {
        missing.push(ref.filename);
        continue;
      }
      const slot = `${ref.role}|${ref.optionLabel ?? ""}`;
      const order = nextOrder.get(slot) ?? 0;
      nextOrder.set(slot, order + 1);
      assets.push({
        role: ref.role,
        optionLabel: ref.role === "OPTION" ? ref.optionLabel : null,
        order,
        storageKey: hit.storageKey,
        alt: ref.decorative ? "" : ref.alt && ref.alt.length >= 3 ? ref.alt : fallbackAlt(ref),
        caption: ref.caption,
        width: hit.width ?? 0,
        height: hit.height ?? 0,
        darkBacking: true,
      });
    }
    const text = composeQuestionText(m);
    const options = m.options.map((o) => ({ label: o.label, text: o.text }));
    // RICH_V1 assets are only frozen for RICH_V1 questions — exactly like the player.
    const views = liveRichViews({ contentFormat: m.contentFormat ?? "PLAIN", text, explanation: m.explanation, options, assets });

    return NextResponse.json({
      rowNumber: row.rowNumber,
      severity: row.severity,
      errors: row.errors ?? [],
      warnings: row.warnings ?? [],
      infos: row.infos ?? [],
      contentFormat: m.contentFormat,
      questionType: m.questionType,
      text,
      options: m.options.map((o) => ({ label: o.label, text: o.text, isCorrect: m.correct.includes(o.label) })),
      rich: views.rich,
      explanation: views.explanation,
      missingImages: missing,
      manifest: m,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET bulk-import row preview error:", error);
    return NextResponse.json({ error: "Failed to build the preview" }, { status: 500 });
  }
}
