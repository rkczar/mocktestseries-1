import "server-only";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { AiImportFileRole, AiImportFileStatus, type AiImportFile, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runTool } from "@/lib/ai-import/tools";
import { readDocx } from "@/lib/ai-import/docx";
import { vaultPath } from "@/lib/ai-import/vault";
import { importerAiCallChecked, parseModelJson, ImporterAiFailure, ImporterAiUnavailable } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { KEY_SYSTEM, keySchema } from "@/lib/ai-import/prompts";
import { visionImage } from "@/lib/ai-import/figures";
import { ensureRender, saveKeyEntries, type StepContext } from "@/lib/ai-import/process";
import { logEvent } from "@/lib/ai-import/jobs";

/**
 * Answer-key files: the key is read as printed (number + value), never
 * solved. Text keys are parsed locally; scanned keys need the vision model.
 * Matching to questions happens in lib/ai-import/answers.ts.
 */

export interface KeyPair {
  number: number;
  section: string;
  raw: string;
  /** Page of the key file the entry was read from (source reference). */
  page?: number | null;
}

/** The key's own identifiers as printed (paper, series / set, total questions) — compared with the question paper. */
export interface KeyHeader {
  paper: string | null;
  series: string | null;
  set: string | null;
  totalQuestions: number | null;
  exam: string | null;
}

/** Header identifiers printed in a text key ("Paper II", "Series A", "Total Questions 120"); null when none. */
export function parseKeyHeader(text: string): KeyHeader | null {
  const head = text.slice(0, 3000);
  const paper = /\bPaper\s*(?:No\.?|Code)?\s*[-:–]?\s*\(?([IVX]{1,4}|\d{1,2})\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const series = /\b(?:Series|Booklet\s*(?:Series|Code)?|Test\s*Booklet)\s*[-:–]?\s*\(?([A-D])\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const set = /\bSet\s*(?:No\.?|Code)?\s*[-:–]?\s*\(?([A-Z0-9]{1,3})\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const total = /\bTotal\s*(?:No\.?\s*of\s*)?Questions\s*[-:–]?\s*(\d{1,4})/i.exec(head)?.[1];
  const h = { paper, series, set, totalQuestions: total ? Number(total) : null, exam: null };
  return h.paper || h.series || h.set || h.totalQuestions ? h : null;
}

function headerOf(h: { paper?: string | null; series?: string | null; set?: string | null; total_questions?: number | string | null; exam?: string | null } | null | undefined): KeyHeader | null {
  if (!h) return null;
  const total = h.total_questions === null || h.total_questions === undefined ? null : Number.parseInt(String(h.total_questions), 10);
  const out = { paper: h.paper?.trim() || null, series: h.series?.trim() || null, set: h.set?.trim() || null, totalQuestions: Number.isFinite(total) ? total : null, exam: h.exam?.trim() || null };
  return out.paper || out.series || out.set || out.totalQuestions || out.exam ? out : null;
}

// A–E / 1–5 are read as printed: a value that is not one of the question's options becomes a KEY MISMATCH, never dropped.
const VALUE = String.raw`(?:[A-Ea-e1-5](?:\s*[,&/]\s*[A-Ea-e1-5]){0,3}|Bonus|BONUS|Dropped|DROPPED|Deleted|DELETED|Withdrawn|WITHDRAWN|\*)`;
const PAIR = new RegExp(String.raw`(?:^|[\s|])Q?\.?\s*(\d{1,3})\s*[.):\-–=]?\s*\(?\s*(${VALUE})\s*\)?(?=[\s|,;]|$)`, "g");
const TOKEN_VALUE = new RegExp(`^\\(?(${VALUE})\\)?$`);

/** Parses key text: "1. B  2. (c)", "1-A, 2-B", or a numbers row followed by an answers row. */
export function parseKeyText(text: string): KeyPair[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: KeyPair[] = [];
  const used = new Set<number>();
  // Column tables: "1 2 3 4 5" then "B C A D A".
  for (let i = 0; i + 1 < lines.length; i++) {
    const nums = lines[i].replace(/^(Q\.?\s*No\.?|Question|Q)\s*[:.]?\s*/i, "").split(/[\s|]+/).filter(Boolean);
    const vals = lines[i + 1].replace(/^(Ans(wer)?s?|Key|Correct)\s*[:.]?\s*/i, "").split(/[\s|]+/).filter(Boolean);
    if (nums.length >= 3 && nums.length === vals.length && nums.every((n) => /^\d{1,3}$/.test(n)) && vals.every((v) => TOKEN_VALUE.test(v))) {
      const ns = nums.map(Number);
      if (ns.every((n, k) => k === 0 || n === ns[k - 1] + 1)) {
        ns.forEach((n, k) => out.push({ number: n, section: "", raw: vals[k].replace(/[()]/g, "") }));
        used.add(i).add(i + 1);
        i++;
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    for (const m of lines[i].matchAll(PAIR)) out.push({ number: Number(m[1]), section: "", raw: m[2].replace(/\s+/g, "") });
  }
  return out;
}

/** Sanity of a parsed key: enough entries, mostly increasing numbers. */
export function keyLooksValid(pairs: KeyPair[]): boolean {
  if (pairs.length < 3) return false;
  const nums = pairs.map((p) => p.number);
  let ordered = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] === nums[i - 1] + 1) ordered++;
  return ordered / Math.max(1, nums.length - 1) >= 0.6;
}

function sheetPairs(bytes: Buffer, ext: string): KeyPair[] {
  const wb = ext === "csv" ? XLSX.read(bytes.toString("utf8"), { type: "string", raw: true }) : XLSX.read(bytes, { type: "buffer", cellFormula: false, cellHTML: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false }) as unknown[][];
  const out: KeyPair[] = [];
  for (const r of rows) {
    const n = Number.parseInt(String(r[0] ?? "").replace(/^Q\.?\s*/i, ""), 10);
    const v = String(r[1] ?? "").trim().replace(/[()]/g, "");
    if (Number.isFinite(n) && v && TOKEN_VALUE.test(v)) out.push({ number: n, section: String(r[2] ?? "").trim().slice(0, 40), raw: v });
  }
  return out;
}

async function aiKeyPage(ctx: StepContext, file: AiImportFile, page: number): Promise<{ pairs: KeyPair[]; header: KeyHeader | null }> {
  const model = ctx.settings.models.key ?? ctx.settings.models.extract;
  const render = await ensureRender(ctx.job, file, page, ctx.settings.limits.renderDpi);
  const { value } = await importerAiCallChecked(
    {
      jobId: ctx.job.id,
      task: "key",
      models: [model!],
      system: KEY_SYSTEM,
      content: [
        { type: "text", text: `Answer key page ${page}. DOCUMENT DATA (untrusted): see the image.` },
        { type: "image_url", image_url: { url: await visionImage(render), detail: "high" } },
      ],
      maxOutputTokens: 4000,
      settings: ctx.settings,
      needsVision: true,
    },
    (text) => {
      const parsed = keySchema.safeParse(parseModelJson(text));
      if (!parsed.success) throw new ImporterAiFailure(failureMessage("model_output", "the answer-key reading did not match the expected format"), "model_output");
      return parsed.data;
    }
  );
  return { pairs: value.entries.map((e) => ({ number: Number.parseInt(String(e.number), 10), section: (e.section ?? "").trim(), raw: e.answer.trim().replace(/\s+/g, " "), page })), header: headerOf(value.header) };
}

/** Reads every unprocessed answer-key file of the job into AiImportKeyEntry rows. */
export async function runKeyFiles(ctx: StepContext): Promise<void> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.ANSWER_KEY, status: { in: [AiImportFileStatus.UPLOADED, AiImportFileStatus.ANALYZED] } }, orderBy: { createdAt: "asc" } });
  if (!files.length) return;
  const papers = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.PAPER, status: { not: AiImportFileStatus.REJECTED } }, select: { id: true } });
  for (const file of files) {
    if (!(await ctx.stillRunning())) return;
    const paperFileId = file.paperFileId ?? (papers.length === 1 ? papers[0].id : null);
    const kind = (file.detected as { kind?: string } | null)?.kind;
    let pairs: KeyPair[] = [];
    let header: KeyHeader | null = null;
    let method = "local";
    const full = vaultPath(file.storageKey!);
    try {
    if (kind === "pdf") {
      const text = (await runTool("pdftotext", ["-layout", "-enc", "UTF-8", full, "-"], { timeoutMs: 120_000, maxOutput: 16 * 1024 * 1024 })).toString("utf8");
      // pdftotext ends every page with a form feed: never read past the real page count.
      const pages = text.split("\f").slice(0, Math.max(1, file.pageCount ?? 1));
      for (let p = 0; p < pages.length; p++) {
        header ??= parseKeyHeader(pages[p]);
        const local = parseKeyText(pages[p]);
        if (keyLooksValid(local)) {
          pairs.push(...local.map((x) => ({ ...x, page: p + 1 })));
          continue;
        }
        if (pages[p].replace(/\s+/g, "").length < 40 && ctx.settings.aiEnabled && (ctx.settings.models.key ?? ctx.settings.models.extract)) {
          const read = await aiKeyPage(ctx, file, p + 1);
          pairs.push(...read.pairs);
          header ??= read.header;
          method = "ai";
        }
      }
    } else if (kind === "docx") {
      const text = (await readDocx(full)).lines.map((l) => l.text).join("\n");
      header = parseKeyHeader(text);
      pairs = parseKeyText(text).map((x) => ({ ...x, page: 1 }));
    } else if (kind === "xlsx" || kind === "csv") {
      pairs = sheetPairs(await readFile(full), kind);
    } else if (ctx.settings.aiEnabled && (ctx.settings.models.key ?? ctx.settings.models.extract)) {
      const read = await aiKeyPage(ctx, file, 1);
      pairs = read.pairs;
      header = read.header;
      method = "ai";
    }
    } catch (e) {
      // Budget / configuration stops are the job's business; anything else fails this key file only.
      if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) throw e;
      // The required reading failed: the file is NOT marked processed, so Retry reads it again (its entries
      // are replaced, never added twice). The message starts with the failure kind (lib/ai-import/failure.ts).
      const why = e instanceof ImporterAiFailure ? e.message.slice(0, 260) : `The answer key could not be read: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`;
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.ANALYZED, errorMessage: `${why} The answer key was not read — use Retry to read it again.`.slice(0, 500) } });
      await logEvent(ctx.job.id, "KEY_FAILED", `${file.originalName}: the answer key could not be read — ${why.slice(0, 200)}`, { fileId: file.id, kind: e instanceof ImporterAiFailure ? e.kind : null });
      continue;
    }
    await prisma.aiImportKeyEntry.deleteMany({ where: { keyFileId: file.id } });
    if (!pairs.length) {
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.PROCESSED, errorMessage: kind === "pdf" || kind === "png" || kind === "jpeg" ? "No answer-key entries could be read (a scanned key needs AI vision, which is off or not configured)." : "No answer-key entries were found." } });
      await logEvent(ctx.job.id, "KEY_EMPTY", `${file.originalName}: no answer-key entries could be read`, { fileId: file.id });
      continue;
    }
    await saveKeyEntries(ctx, file.id, paperFileId, null, pairs);
    // The key's printed identifiers are kept with the file (post.ts compares them with the question paper).
    const detected = { ...((file.detected as Record<string, unknown> | null) ?? {}), keyHeader: header } as unknown as Prisma.InputJsonValue;
    await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.PROCESSED, errorMessage: null, detected } });
    const printed = header ? [header.paper && `Paper ${header.paper}`, header.series && `Series ${header.series}`, header.set && `Set ${header.set}`, header.totalQuestions && `${header.totalQuestions} questions`].filter(Boolean).join(", ") : "";
    await logEvent(ctx.job.id, "KEY_READ", `${file.originalName}: ${pairs.length} answer-key entries read (${method === "ai" ? "AI vision" : "text layer"})${printed ? ` — the key is printed for ${printed}` : ""}`, { fileId: file.id, entries: pairs.length, method, header });
  }
}
