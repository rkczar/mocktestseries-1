/**
 * Question-by-question reconciliation of one bilingual import job — READ-ONLY (no writes, no AI).
 * Every printed number 1..expected is listed, found or not: English, Hindi, pair status, answer key, figures, issues;
 * then every source page; then the totals. Markdown to stdout (or <out.md>) plus a CSV next to it.
 *
 *   DATABASE_URL=<db> npx tsx scripts/bilingual-reconciliation-report.ts <jobId> [out.md]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

const jobId = process.argv[2];
const out = process.argv[3];
if (!jobId) {
  console.error("usage: bilingual-reconciliation-report.ts <jobId> [out.md]");
  process.exit(2);
}

const clip = (s: string | null | undefined, n = 90) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n) + ((s ?? "").length > n ? "…" : "");
const md = (s: string) => s.replace(/\|/g, "\\|");
const csv = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;

async function main() {
  // Read-only session: any accidental write fails instead of changing data.
  await prisma.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const exam = await prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true, languageMode: true } });
  const paperFile = await prisma.aiImportFile.findFirst({ where: { jobId, role: "PAPER" }, orderBy: { createdAt: "asc" } });
  const pages = await prisma.aiImportPage.findMany({ where: { jobId, ...(paperFile ? { fileId: paperFile.id } : {}) }, orderBy: { pageNumber: "asc" } });
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
  const keys = await prisma.aiImportKeyEntry.findMany({ where: { jobId } });
  const calls = await prisma.aiImportAiCall.findMany({ where: { jobId } });
  const expected = job.expectedQuestions ?? Math.max(0, ...qs.map((q) => ((q.editedData ?? q.data) as unknown as ExtractedQuestion).number ?? 0));

  const byNumber = new Map<number, typeof qs>();
  const unnumbered: typeof qs = [];
  for (const q of qs) {
    const n = ((q.editedData ?? q.data) as unknown as ExtractedQuestion).number;
    if (n === null || n === undefined) unnumbered.push(q);
    else byNumber.set(n, [...(byNumber.get(n) ?? []), q]);
  }
  const keyBy = new Map(keys.map((k) => [k.sourceNumber, k]));

  const rows: string[][] = [];
  const t = { en: 0, hi: 0, matched: 0, unmatched: 0, missingOptions: 0, formula: 0, diagram: 0, answer: 0, duplicates: 0, imported: 0, pending: 0, deleted: 0, missing: 0 };
  const unresolved: string[] = [];
  for (let n = 1; n <= expected; n++) {
    const found = byNumber.get(n) ?? [];
    const k = keyBy.get(n);
    if (!found.length) {
      t.missing++;
      unresolved.push(`Q${n}: not extracted from any page`);
      rows.push([String(n), "—", "—", "NOT FOUND", k?.rawValue ?? "—", "—", "—", "NOT EXTRACTED", "—"]);
      continue;
    }
    if (found.length > 1) {
      t.duplicates++;
      unresolved.push(`Q${n}: read ${found.length} times`);
    }
    const q = found[0];
    const e = (q.editedData ?? q.data) as unknown as ExtractedQuestion;
    const codes = q.issueCodes;
    if (e.stem.trim()) t.en++;
    if (e.hi?.stem.trim()) t.hi++;
    const pairBad = codes.filter((c) => c.startsWith("BILINGUAL"));
    if (exam?.languageMode === "BILINGUAL") {
      if (pairBad.length) t.unmatched++;
      else t.matched++;
    }
    if (codes.includes("OPTIONS_INCOMPLETE") || e.options.length !== 4) t.missingOptions++;
    if (codes.includes("FORMULA_ISSUE")) t.formula++;
    if (codes.some((c) => c.startsWith("IMAGE_"))) t.diagram++;
    const deleted = q.answerStatus === "WITHDRAWN";
    if (deleted) t.deleted++;
    else if (q.answerStatus !== "OFFICIAL_MATCHED") t.answer++;
    if (q.questionId) t.imported++;
    else if (!deleted) t.pending++;
    const pair = exam?.languageMode !== "BILINGUAL" ? "n/a" : pairBad.length ? pairBad.join(", ") : e.hi?.confirmedById ? "MATCHED (admin-checked)" : "MATCHED";
    const answer = deleted ? `DELETED in key (${k?.rawValue ?? "*"})` : `${q.answerStatus}${q.finalAnswer.length ? ` → ${q.finalAnswer.join(",")}` : ""} (key ${q.officialAnswerRaw ?? k?.rawValue ?? "—"})`;
    const figs = q.figures.length ? q.figures.map((f) => `${f.owner}${f.optionLabel ? `:${f.optionLabel}` : ""} ${f.mappingStatus}${f.confirmedById ? "✓" : ""}`).join("; ") : "none";
    const status = q.questionId ? (q.status === "PUBLISHED" ? "PUBLISHED" : "IMPORTED") : deleted ? "NOT IMPORTED (deleted)" : codes.length ? `REVIEW (${q.status})` : q.status;
    const open = codes.filter((c) => !["NUMBERING_GAP", "SECTION_SUBJECT_DIFFERS"].includes(c));
    if (!q.questionId && !deleted && open.length) unresolved.push(`Q${n}: ${open.join(", ")}`);
    rows.push([String(n), clip(e.stem), clip(e.hi?.stem), pair, answer, figs, e.pages.join(","), status, open.join(", ") || "—"]);
  }
  for (const q of unnumbered) unresolved.push(`unnumbered question on page(s) ${q.pages.join(",")}: ${clip(((q.editedData ?? q.data) as unknown as ExtractedQuestion).stem, 60)}`);
  const extraNumbers = [...byNumber.keys()].filter((n) => n > expected);
  for (const n of extraNumbers) unresolved.push(`Q${n}: beyond the expected ${expected} questions`);

  const spent = calls.reduce((a, c) => a + (c.costInr ?? 0), 0);
  const complete = expected ? Math.round((t.imported / (expected - t.deleted)) * 1000) / 10 : 0;
  const lines: string[] = [];
  lines.push(`# Reconciliation — ${job.title}`, "", `Job ${job.id} · exam ${exam?.name} (${exam?.languageMode}) · year ${job.year ?? "—"} · status ${job.status} · generated ${new Date().toISOString()}`, "");
  lines.push("## Totals", "", "| Item | Count |", "|---|---|");
  for (const [k, v] of [
    ["Source pages", pages.length],
    ["Expected questions", expected],
    ["English versions extracted", t.en],
    ["Hindi versions extracted", t.hi],
    ["Bilingual pairs matched (no pair issue)", t.matched],
    ["Pairs with an unresolved Hindi/English issue", t.unmatched],
    ["Numbers not extracted at all", t.missing],
    ["Questions with missing / incomplete options", t.missingOptions],
    ["Formula exceptions", t.formula],
    ["Diagram exceptions", t.diagram],
    ["Answer-key exceptions (not official-matched, excl. deleted)", t.answer],
    ["Deleted in the official key (never imported)", t.deleted],
    ["Duplicate readings of a number", t.duplicates],
    ["Imported into the Question Bank", t.imported],
    ["Pending review / not imported", t.pending],
    ["Import completion (imported ÷ non-deleted expected)", `${complete}%`],
    ["AI calls / recorded cost", `${calls.length} / ₹${spent.toFixed(2)}`],
  ] as const)
    lines.push(`| ${k} | ${v} |`);
  lines.push("", `**Unresolved (${unresolved.length})**`, "", ...(unresolved.length ? unresolved.map((u) => `- ${u}`) : ["- none"]), "");
  lines.push("## Pages", "", "| Page | Outcome | Model | Question numbers | Reason |", "|---|---|---|---|---|");
  for (const p of pages) {
    const nums = qs.filter((q) => q.fileId === p.fileId && q.pages.includes(p.pageNumber)).map((q) => ((q.editedData ?? q.data) as unknown as ExtractedQuestion).number ?? "?");
    lines.push(`| ${p.pageNumber} | ${p.outcome ?? p.status} | ${p.model ?? "—"} | ${nums.join(", ") || "—"} | ${md(clip(p.outcomeReason, 120))} |`);
  }
  lines.push("", "## Questions", "", "| Q | English | Hindi | Pair | Answer key | Figures | Pages | Status | Open issues |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) lines.push(`| ${r.map(md).join(" | ")} |`);
  const text = lines.join("\n");
  if (out) {
    writeFileSync(out, text);
    writeFileSync(out.replace(/\.md$/, "") + ".csv", ["Q,English,Hindi,Pair,Answer key,Figures,Pages,Status,Open issues", ...rows.map((r) => r.map(csv).join(","))].join("\n"));
    console.log(`written ${out} (+ .csv): ${expected} numbers, ${unresolved.length} unresolved`);
  } else console.log(text);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
