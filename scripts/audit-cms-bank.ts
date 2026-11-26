/**
 * UPSC CMS Question Bank source audit (2026-11-26). READ-ONLY: compares every CMS Question Bank record with its original
 * source (text inside its stored source crop: PDF text-layer words, else local-OCR lines, else a fresh local OCR of the
 * crop) and with the official answer key; checks numbering, duplicates and images. Writes JSON + a Markdown report.
 *   cd /var/www/mocktestseries-current && set -a && . ./.env && set +a && PG_POOL_MAX=3 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-cms-bank.ts <outDir> [fromYear] [toYear]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { runTool } from "@/lib/ai-import/tools";
import { vaultPath } from "@/lib/ai-import/vault";
import { OCR_DPI } from "@/lib/ai-import/ocr";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { parseKeyAnswer } from "@/lib/ai-import/fidelity";
import { compareToSource, proposedStem, type Finding } from "@/lib/question-source/audit-compare";

type Box = { x: number; y: number; w: number; h: number };
type Word = { x: number; y: number; t: string };
const DROPPED = /^(bonus|dropped|deleted|withdrawn|\*|x|×)$/i;
const IMG_WORDS = /\b(figure|fig\.|image|photograph|picture|shown (?:below|above|here)|given (?:below|above) (?:is|are) (?:the )?(?:x-ray|ecg|image)|x-ray shown|ecg shown|radiograph|histopatholog\w* (?:image|picture|slide))\b/i;

const pageWords = new Map<string, { words: Word[]; scanned: boolean } | null>();
async function wordsOf(file: { id: string; storageKey: string | null; detected: unknown; status: string }, page: number): Promise<{ words: Word[]; scanned: boolean } | null> {
  const k = `${file.id}:${page}`;
  if (pageWords.has(k)) return pageWords.get(k)!;
  let res: { words: Word[]; scanned: boolean } | null = null;
  const kind = (file.detected as { kind?: string } | null)?.kind;
  let size: { w: number; h: number } | null = null;
  if (kind === "pdf" && file.storageKey && file.status !== "PURGED") {
    try {
      const xml = (await runTool("pdftotext", ["-bbox-layout", "-f", String(page), "-l", String(page), vaultPath(file.storageKey), "-"], { timeoutMs: 60_000, maxOutput: 16 * 1024 * 1024 })).toString("utf8");
      const pg = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(xml);
      if (pg) {
        const W = Number(pg[1]);
        const H = Number(pg[2]);
        size = { w: (W / 72) * OCR_DPI, h: (H / 72) * OCR_DPI };
        const ws = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x: (Number(m[1]) + Number(m[3])) / 2 / W, y: (Number(m[2]) + Number(m[4])) / 2 / H, t: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'") }));
        if (ws.length >= 40) res = { words: ws, scanned: false };
      }
    } catch {
      /* scanned / unreadable → OCR lines */
    }
  }
  if (!res) {
    const p = await prisma.aiImportPage.findFirst({ where: { fileId: file.id, pageNumber: page }, select: { ocrLines: true, renderWidth: true, renderHeight: true } });
    if (p && Array.isArray(p.ocrLines) && p.ocrLines.length) {
      const sz = size ?? (p.renderHeight ? { w: (p.renderWidth ?? 0) * (OCR_DPI / 150), h: p.renderHeight * (OCR_DPI / 150) } : null);
      if (sz) res = { words: (p.ocrLines as { text?: string; box?: number[] }[]).filter((l) => l.box && l.text).map((l) => ({ x: (l.box![0] + l.box![2]) / 2 / sz.w, y: (l.box![1] + l.box![3]) / 2 / sz.h, t: l.text! })), scanned: true };
    }
  }
  pageWords.set(k, res);
  return res;
}

async function ocrCrop(key: string): Promise<string | null> {
  try {
    const o = JSON.parse((await runTool("ocr", ["--image", vaultPath(key)], { timeoutMs: 240_000, memoryMb: 2048, maxOutput: 16 * 1024 * 1024 })).toString("utf8")) as { lines?: { text?: string; box?: number[] }[] };
    return (o.lines ?? []).sort((a, b) => (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0)).map((l) => l.text ?? "").join("\n");
  } catch {
    return null;
  }
}

async function main() {
  const [outDir = "/root/mts-evidence/cms-audit", fromY = "2009", toY = "2026"] = process.argv.slice(2);
  mkdirSync(outDir, { recursive: true });
  const papers = await prisma.previousYearPaper.findMany({ where: { title: { contains: "CMS", mode: "insensitive" }, year: { gte: Number(fromY), lte: Number(toY) } }, orderBy: [{ year: "asc" }, { title: "asc" }], select: { id: true, year: true, title: true } });
  const keyStates = new Map<string, Set<string>>();
  const results: unknown[] = [];
  const matrix: Record<string, unknown>[] = [];
  for (const p of papers) {
    const qs = await prisma.question.findMany({
      where: { previousYearPaperId: p.id, status: { not: "ARCHIVED" } },
      orderBy: { paperQuestionNumber: "asc" },
      select: { id: true, code: true, status: true, paperQuestionNumber: true, text: true, imageUrl: true, answerVerification: true, reviewRequired: true, reviewReason: true, questionType: true, options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } }, assets: { select: { role: true } }, sourceEvidence: true },
    });
    const jobs = await prisma.aiImportJob.findMany({ where: { previousYearPaperId: p.id, status: { not: "CANCELLED" } }, select: { id: true, title: true, expectedQuestions: true } });
    const expected = Math.max(120, ...jobs.map((j) => j.expectedQuestions ?? 0));
    const nums = qs.map((q) => q.paperQuestionNumber).filter((n): n is number => typeof n === "number");
    const missing = Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !nums.includes(n));
    const dupNums = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
    const row = { paper: `${p.year} ${p.title}`, paperId: p.id, sourceJobs: jobs.length, expected, db: qs.length, missing, duplicates: dupNums.map((n) => ({ number: n, ids: qs.filter((q) => q.paperQuestionNumber === n).map((q) => `${q.code} (${q.status})`) })), withSource: 0, sourceTextRead: 0, verified: 0, review: 0, counts: {} as Record<string, number> };
    for (const q of qs) {
      const ev = q.sourceEvidence;
      const findings: (Finding | { code: string; severity: string; detail: string })[] = [];
      let sourceText: string | null = null;
      if (!ev) findings.push({ code: "SOURCE_UNAVAILABLE", severity: "INFO", detail: "no stored source evidence (not imported by the AI importer, or before evidence was kept)" });
      else {
        row.withSource++;
        const file = ev.fileId ? await prisma.aiImportFile.findUnique({ where: { id: ev.fileId }, select: { id: true, storageKey: true, detected: true, status: true } }) : null;
        const crops = (Array.isArray(ev.questionCrops) ? ev.questionCrops : []) as { key: string; page: number; box: Box | null }[];
        if (!crops.length) findings.push({ code: "SOURCE_CROP_MISSING", severity: "MINOR", detail: ev.cropNote ?? "no source crop" });
        if (file && crops.length) {
          const parts: string[] = [];
          for (const c of crops) {
            const pw = await wordsOf(file, c.page);
            if (pw) {
              const b = c.box ?? { x: 0, y: 0, w: 1, h: 1 };
              // A one-column crop of a two-column page (≈ half width) also shows the edge of the other column: read only
              // the words whose centre is in this column half.
              const half = b.w < 0.6 ? (b.x < 0.25 ? [0, 0.5] : [0.5, 1]) : [0, 1];
              parts.push(pw.words.filter((w) => w.x >= Math.max(b.x, half[0]) && w.x <= Math.min(b.x + b.w, half[1]) && w.y >= b.y && w.y <= b.y + b.h).map((w) => w.t).join(" "));
            } else {
              const t = await ocrCrop(c.key);
              if (t) parts.push(t);
            }
          }
          sourceText = parts.join("\n").trim() || null;
        }
        if (sourceText) {
          row.sourceTextRead++;
          findings.push(...compareToSource({ number: q.paperQuestionNumber, stem: q.text, options: q.options.map((o) => ({ label: o.label, text: o.text })) }, sourceText));
        } else if (crops.length) findings.push({ code: "SOURCE_TEXT_UNREADABLE", severity: "MINOR", detail: "the source crop has no readable text layer / OCR" });
        // Answer vs the official key entry (official key files only).
        if (ev.jobId && q.status !== "WITHDRAWN") {
          if (!keyStates.has(ev.jobId)) keyStates.set(ev.jobId, new Set((await keyPaperChecks(ev.jobId)).filter((c) => c.state === "MATCH" || c.state === "CONFIRMED").map((c) => c.keyFileId)));
          const off = keyStates.get(ev.jobId)!;
          const entries = off.size && q.paperQuestionNumber ? await prisma.aiImportKeyEntry.findMany({ where: { jobId: ev.jobId, keyFileId: { in: [...off] }, sourceNumber: q.paperQuestionNumber, section: ev.section ?? "", OR: [{ paperFileId: ev.fileId }, { paperFileId: null }] }, select: { rawValue: true } }) : [];
          const vals = [...new Set(entries.map((e) => e.rawValue.toUpperCase().replace(/[()\s]/g, "")))];
          const cur = q.options.filter((o) => o.isCorrect).map((o) => o.label).sort().join(",");
          if (!off.size) findings.push({ code: "ANSWER_KEY_UNAVAILABLE", severity: "INFO", detail: "no official answer key for this paper in the system" });
          else if (!vals.length) findings.push({ code: "ANSWER_KEY_ENTRY_MISSING", severity: "MAJOR", detail: `official key has no entry for Q${q.paperQuestionNumber}; stored answer ${cur || "none"} (${q.answerVerification ?? "—"})` });
          else if (vals.length > 1) findings.push({ code: "ANSWER_KEY_CONFLICT", severity: "MAJOR", detail: `official key entries disagree: ${vals.join(" / ")}; stored ${cur}` });
          else if (DROPPED.test(vals[0])) findings.push({ code: "WITHDRAWN_NOT_MARKED", severity: "CRITICAL", detail: `official key drops Q${q.paperQuestionNumber} ("${vals[0]}") but the record is ${q.status}` });
          else {
            const key = (parseKeyAnswer(entries[0].rawValue, q.options.map((o) => o.label)).labels ?? []).sort().join(",");
            if (key && key !== cur) findings.push({ code: "ANSWER_KEY_MISMATCH", severity: "CRITICAL", detail: `official key ${key}, Question Bank ${cur || "none"} (${q.answerVerification ?? "—"})` });
          }
        }
        // Images: the importer saw a figure but the record has none; or the text refers to one.
        const figs = ev.aiImportQuestionId ? await prisma.aiImportFigure.count({ where: { questionId: ev.aiImportQuestionId } }) : 0;
        const imgs = q.assets.length + (q.imageUrl ? 1 : 0) + q.options.filter((o) => o.imageUrl).length;
        if (figs > 0 && imgs === 0) findings.push({ code: "IMAGE_MISSING", severity: "CRITICAL", detail: `${figs} figure(s) found on the source, none on the Question Bank record` });
        else if (imgs === 0 && IMG_WORDS.test(q.text)) findings.push({ code: "IMAGE_REVIEW_REQUIRED", severity: "MAJOR", detail: "the question refers to an image / figure but the record has none" });
      }
      if (q.answerVerification === "UNVERIFIED" && q.status !== "WITHDRAWN") findings.push({ code: "ANSWER_UNVERIFIED", severity: "MAJOR", detail: "the stored answer is not from an official key" });
      const real = findings.filter((f) => f.severity !== "INFO");
      for (const f of real) row.counts[f.code] = (row.counts[f.code] ?? 0) + 1;
      if (real.length) row.review++;
      else if (sourceText) row.verified++;
      results.push({ paper: row.paper, number: q.paperQuestionNumber, id: q.id, code: q.code, status: q.status, reviewRequired: q.reviewRequired, reviewReason: q.reviewReason, findings, sourceText: real.length ? sourceText?.slice(0, 1500) : undefined, proposedStem: sourceText ? proposedStem(q.text, sourceText) : null, dbText: real.length ? [q.text, ...q.options.map((o) => `(${o.label}) ${o.text}`)].join("\n").slice(0, 1500) : undefined, page: ev?.pages ?? [], file: ev?.fileName ?? null });
    }
    matrix.push(row);
    console.log(row.paper, `db ${row.db} src ${row.withSource} read ${row.sourceTextRead} verified ${row.verified} review ${row.review}`, JSON.stringify(row.counts));
  }
  writeFileSync(`${outDir}/audit.json`, JSON.stringify({ at: new Date().toISOString(), matrix, results }, null, 1));
  console.log("written", `${outDir}/audit.json`, results.length);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
