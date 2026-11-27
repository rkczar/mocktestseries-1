/**
 * Fixture for the Question Verification Workspace browser suite (scratch DB + scratch vault only).
 * Runs on top of the verify-importer-review-global fixture: turns its paper into a real 3-page PDF with page rows, so the
 * full-page viewer has something to show. Q1+Q2 → page 1, Q3 → page 2, Q4 → no page mapping, Q2 gets an explanation.
 *   AI_IMPORT_VAULT_DIR=/root/mts-scratch/… npx tsx scripts/verify-verify-workspace.ts setup <irg.json>
 * `single <irg.json>` then cuts that file down to page 1 only (run after the main suite; Q3 stays mapped to page 2).
 */
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { putContent } from "@/lib/ai-import/vault";

function guard() {
  if (!/^\/root\/mts-scratch\//.test(process.env.AI_IMPORT_VAULT_DIR ?? "")) throw new Error("AI_IMPORT_VAULT_DIR must be a /root/mts-scratch/ directory");
  if (!/\/mts_[^/?]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must be a scratch mts_* database");
}

async function setup(f: { jobId: string; ids: string[] }) {
  guard();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`VWS ORIGINAL PAGE ${n}`, { x: 50, y: 790, size: 28, font });
    p.drawText(`Footer page ${n} of 3`, { x: 50, y: 30, size: 12, font });
  }
  const pdf = Buffer.from(await doc.save());
  const v = await putContent("files", pdf, "pdf");
  const q1 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: f.ids[0] }, select: { fileId: true } });
  await prisma.aiImportFile.update({ where: { id: q1.fileId }, data: { originalName: "paper.pdf", ext: "pdf", storageKey: v.key, pageCount: 3, detected: { kind: "pdf" } } });
  for (let n = 1; n <= 3; n++) await prisma.aiImportPage.upsert({ where: { fileId_pageNumber: { fileId: q1.fileId, pageNumber: n } }, create: { jobId: f.jobId, fileId: q1.fileId, pageNumber: n, status: "DONE" as never, kind: "SCANNED" }, update: {} });
  const pagesOf = [[1], [1], [2], []];
  for (let i = 0; i < pagesOf.length; i++) {
    const q = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: f.ids[i] }, select: { data: true } });
    const data = { ...(q.data as object), pages: pagesOf[i], ...(i === 1 ? { hints: { explanation: "VWS explanation for Q2" } } : {}) };
    await prisma.aiImportQuestion.update({ where: { id: f.ids[i] }, data: { pages: pagesOf[i], data: data as never } });
  }
  console.log("workspace fixture ready");
}

async function single(f: { ids: string[] }) {
  guard();
  const { fileId } = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: f.ids[0] }, select: { fileId: true } });
  await prisma.aiImportPage.deleteMany({ where: { fileId, pageNumber: { gt: 1 } } });
  await prisma.aiImportFile.update({ where: { id: fileId }, data: { pageCount: 1 } });
  console.log("single-page fixture ready");
}

const [mode, path] = process.argv.slice(2);
if (!["setup", "single"].includes(mode) || !path) throw new Error("usage: setup|single <irg.json>");
(mode === "setup" ? setup : single)(JSON.parse(readFileSync(path, "utf8"))).finally(() => prisma.$disconnect());
