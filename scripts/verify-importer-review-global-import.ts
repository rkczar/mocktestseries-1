/**
 * Independent import ↔ preview regression (scratch only): questions go through the REAL import path (importForced →
 * Bulk Import, scratch storage/vault), then the stored Question rows are compared with studentPreviewOf() for the same
 * importer rows. Proves the student preview shows what the import stores. No AI, no OCR.
 *   DATABASE_URL=<scratch mts_*> STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch>
 *   AI_IMPORT_DISABLE_KICK=1 PG_POOL_MAX=3 NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-review-global-import.ts
 */
import "dotenv/config";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { importForced, studentPreviewOf } from "@/lib/ai-import/adapter";
import { effective } from "@/lib/ai-import/post";
import { putContent } from "@/lib/ai-import/vault";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { QUESTION_PREVIEW_SELECT } from "@/lib/question-preview";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/^\/root\/mts-scratch\//.test(process.env.AI_IMPORT_VAULT_DIR ?? "") || !/^\/root\/mts-scratch\//.test(process.env.STORAGE_DIR ?? "")) {
  console.error("Refusing: scratch mts_* DATABASE_URL and /root/mts-scratch STORAGE_DIR / AI_IMPORT_VAULT_DIR required.");
  process.exit(2);
}
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 600)}`}`);
};
const opts = (texts: string[]) => texts.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));
const xq = (n: number, over: Partial<ExtractedQuestion>): ExtractedQuestion =>
  ({ section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `Stem ${n}`, options: opts(["a", "b", "c", "d"]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "LOCAL_TEXT", ...over }) as ExtractedQuestion;

async function main() {
  const sfx = Date.now().toString(36);
  const master = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } } });
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" } });
  const subject = await prisma.subject.findFirstOrThrow({ where: { originExamId: exam.id } });
  const job = await prisma.aiImportJob.create({ data: { title: `IRG import parity ${sfx}`, status: "NEEDS_REVIEW", examId: exam.id, year: 2024, createdById: master.id, budgetInr: 0, confirmedAt: new Date() } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "p.docx", ext: "docx", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 1, role: "PAPER", detected: { kind: "docx" } } });
  const png = async (rgb: [number, number, number], w: number) => {
    const b = await sharp({ create: { width: w, height: 120, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
    return { ...(await putContent("figures", b, "png")), bytes: b.length, w };
  };
  const cases: { e: ExtractedQuestion; type: string; answer: string[]; figs?: { owner: "STEM" | "OPTION"; label?: string; desc?: string; rgb: [number, number, number]; w: number }[] }[] = [
    // plain text + "$" + stem image → RICH_V1 with "$" escaped; instructions / passage prefixed
    { e: xq(1, { stem: `Costs $5 ${sfx}`, instructions: "Read the passage", passage: "A short passage" }), type: "SINGLE_CORRECT", answer: ["B"], figs: [{ owner: "STEM", desc: "Bar chart", rgb: [200, 30, 30], w: 300 }] },
    // option images, one per option
    { e: xq(2, { stem: `Which image ${sfx}`, options: opts(["Image one", "Image two", "Image three", "Image four"]) }), type: "SINGLE_CORRECT", answer: ["C"], figs: ["A", "B", "C", "D"].map((l, i) => ({ owner: "OPTION" as const, label: l, rgb: [30 * i, 100, 160] as [number, number, number], w: 200 + i })) },
    // structure-only option: text empty, image with formula alt; rich source
    { e: xq(3, { stem: `Structure of $\\ce{CH4}$ ${sfx}`, contentFormat: "RICH_V1", options: opts(["$\\ce{CH3COOH}$", "Ethanol", "Methanol", "Water"]) }), type: "SINGLE_CORRECT", answer: ["A"], figs: [{ owner: "OPTION", label: "A", rgb: [10, 200, 10], w: 250 }] },
    // match the following
    { e: xq(4, { stem: `Match ${sfx}`, type: "MATCH_THE_FOLLOWING", listI: [{ key: "A", text: "Heart" }, { key: "B", text: "Lung" }], listII: [{ key: "1", text: "Pump" }, { key: "2", text: "Gas" }], options: opts(["A-1, B-2", "A-2, B-1", "A-1, B-1", "A-2, B-2"]) } as Partial<ExtractedQuestion>), type: "MATCH_THE_FOLLOWING", answer: ["A"] },
    // multiple correct + explanation
    { e: xq(5, { stem: `Select all ${sfx}`, type: "MULTIPLE_CORRECT", hints: { explanation: "Because both are true." } } as Partial<ExtractedQuestion>), type: "MULTIPLE_CORRECT", answer: ["A", "C"] },
  ];
  const settings = await getImporterSettings();
  try {
    for (const c of cases) {
      const q = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: file.id, sourceKey: `#${c.e.number}`, sourceNumber: c.e.number, sourceLabel: c.e.label, pages: [1], orderIndex: c.e.number!, status: "READY", data: c.e as never, questionType: c.type, optionCount: 4, finalAnswer: c.answer, answerStatus: "OFFICIAL_MATCHED", subjectId: subject.id, approvedById: master.id, approvedAt: new Date() } });
      for (const f of c.figs ?? []) {
        const v = await png(f.rgb, f.w);
        await prisma.aiImportFigure.create({ data: { jobId: job.id, fileId: file.id, questionId: q.id, pageNumber: 1, owner: f.owner, optionLabel: f.label ?? null, source: "UPLOAD", originalKey: v.key, originalSha256: v.sha256, originalMime: "image/png", width: f.w, height: 120, bytes: v.bytes, description: f.desc ?? null } });
      }
      const row = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q.id }, include: { figures: { orderBy: { createdAt: "asc" } } } });
      const preview = studentPreviewOf(row, effective(row), row.figures);
      const item = await importForced(job, row, settings, master.id, "PUBLISH");
      const linked = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q.id }, select: { questionId: true } });
      if (item.outcome === "failed" || !linked.questionId) {
        check(`Q${c.e.number}: imported through the real Bulk Import`, false, item);
        continue;
      }
      const saved = await prisma.question.findUniqueOrThrow({ where: { id: linked.questionId }, select: QUESTION_PREVIEW_SELECT });
      const n = `Q${c.e.number}`;
      check(`${n}: text equals the preview`, saved.text === preview.q.text, { saved: saved.text, preview: preview.q.text });
      check(`${n}: contentFormat + type equal`, saved.contentFormat === preview.q.contentFormat && saved.questionType === preview.q.questionType, [saved.contentFormat, saved.questionType, preview.q.contentFormat, preview.q.questionType]);
      const so = saved.options.map((o) => [o.label, o.text, o.isCorrect]);
      const po = preview.q.options.map((o) => [o.label, o.text, o.isCorrect]);
      check(`${n}: options (label, text, correct) equal`, JSON.stringify(so) === JSON.stringify(po), { so, po });
      check(`${n}: explanation equal`, (saved.explanation ?? null) === (preview.q.explanation ?? null), [saved.explanation, preview.q.explanation]);
      check(`${n}: match lists equal`, JSON.stringify(saved.matchSpec ? { listI: (saved.matchSpec as { listI: unknown }).listI, listII: (saved.matchSpec as { listII: unknown }).listII } : null) === JSON.stringify(preview.q.matchSpec ? { listI: (preview.q.matchSpec as { listI: unknown }).listI, listII: (preview.q.matchSpec as { listII: unknown }).listII } : null), [saved.matchSpec, preview.q.matchSpec]);
      const sa = saved.assets.filter((a) => a.role !== "LIST_ITEM").map((a) => [a.role, a.optionLabel, a.alt, a.width, a.height]).sort();
      const pa = preview.assets.map((a) => [a.role, a.optionLabel, a.alt, a.width, a.height]).sort();
      check(`${n}: images (role, option, alt, size) equal`, JSON.stringify(sa) === JSON.stringify(pa), { sa, pa });
    }
  } finally {
    const ids = (await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, select: { questionId: true } })).map((r) => r.questionId).filter((x): x is string => !!x);
    console.log(`(kept for evidence: job ${job.id}, ${ids.length} scratch Question rows)`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().finally(() => prisma.$disconnect());
