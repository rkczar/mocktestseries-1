/**
 * Offline builder for the typeset Rajasthan FSO Previous Year Paper PDFs (never run inside a request).
 *
 *   NODE_OPTIONS=--conditions=react-server NODE_PATH=<dir with playwright> DATABASE_URL=… STORAGE_DIR=… \
 *     npx tsx scripts/build-paper-pdfs.ts --exam-code RUHS-FSO [--year 2022] [--lang ENGLISH] [--out <dir>] [--dry-run] [--allow-key-mismatch]
 *
 * Source = the question bank (PreviousYearPaper questions by printed number, EN text + Hindi textHi,
 * options in stored order numbered 1–4) — NOT the RPSC scan (no redistribution of scans without a
 * rights review). Answer-key appendix and "deleted" labels come from lib/fso-official.ts (transcribed
 * from RPSC's keys), never from the bank's isCorrect flags. A version is built only when the bank has
 * that language for every question. Every stored answer is compared with the official key; any
 * mismatch on a non-deleted question aborts the build unless --allow-key-mismatch (then listed in the
 * provenance CSV for human review). Output: TestResource PAPER_PDF (INACTIVE) + Setting index entry +
 * provenance CSV. Nothing becomes downloadable until an admin activates the file AND turns the exam's
 * Paper PDF switch on (Admin → Exams → Downloads); the download route also requires login + purchase.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFString } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { FSO_PAPERS, fsoPaperFacts, type FsoPaperFacts } from "@/lib/fso-official";
import { PAPER_PDF_LANGS, PAPER_PDF_LANG_LABEL, upsertPaperPdfEntry, type PaperPdfLang } from "@/lib/paper-pdfs";
import { saveGeneratedResourcePdf } from "@/lib/test-resources";

const SITE = "https://mocktestseries.in/";
const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

interface Args {
  examCode: string;
  year?: number;
  lang?: PaperPdfLang;
  out: string;
  dryRun: boolean;
  allowKeyMismatch: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const lang = get("--lang");
  if (lang && !(PAPER_PDF_LANGS as readonly string[]).includes(lang)) throw new Error(`--lang must be one of ${PAPER_PDF_LANGS.join(", ")}`);
  return {
    examCode: get("--exam-code") ?? "",
    year: get("--year") ? Number(get("--year")) : undefined,
    lang: lang as PaperPdfLang | undefined,
    out: get("--out") ?? path.join(process.cwd(), "paper-pdf-build"),
    dryRun: argv.includes("--dry-run"),
    allowKeyMismatch: argv.includes("--allow-key-mismatch"),
  };
}

export interface PrintedOption {
  en: string;
  hi: string | null;
  isCorrect: boolean;
}
export interface PrintedQuestion {
  number: number;
  questionId: string;
  sourceNote: string;
  status: string;
  en: string;
  hi: string | null;
  options: PrintedOption[];
  flags: string[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const para = (s: string) => esc(s.trim()).replace(/\r?\n/g, "<br>");

/** Loads the paper's 150 printed questions (with the documented reused-question mapping). */
export async function loadPrintedQuestions(examId: string, facts: FsoPaperFacts): Promise<{ questions: PrintedQuestion[]; problems: string[] }> {
  const papers = await prisma.previousYearPaper.findMany({ where: { examId }, select: { id: true, year: true } });
  const byYear = new Map(papers.map((p) => [p.year, p.id]));
  const paperId = byYear.get(facts.year);
  if (!paperId) return { questions: [], problems: [`No ${facts.year} paper in this exam.`] };
  const select = {
    id: true,
    status: true,
    text: true,
    textHi: true,
    imageUrl: true,
    contentFormat: true,
    paperQuestionNumber: true,
    options: { orderBy: { order: "asc" as const }, select: { text: true, textHi: true, isCorrect: true, imageUrl: true } },
    _count: { select: { assets: true } },
  };
  const rows = await prisma.question.findMany({ where: { previousYearPaperId: paperId, retiredAt: null }, select, orderBy: { paperQuestionNumber: "asc" } });
  const byNumber = new Map<number, (typeof rows)[number]>();
  const problems: string[] = [];
  for (const r of rows) {
    if (r.paperQuestionNumber == null) continue;
    if (byNumber.has(r.paperQuestionNumber)) problems.push(`Q${r.paperQuestionNumber}: more than one stored question.`);
    else byNumber.set(r.paperQuestionNumber, r);
  }
  const questions: PrintedQuestion[] = [];
  for (let n = 1; n <= facts.totalQuestions; n++) {
    let row = byNumber.get(n);
    let sourceNote = `${facts.year} paper Q${n}`;
    const reuse = facts.reused?.[n];
    if (!row && reuse) {
      const otherId = byYear.get(reuse.year);
      row = otherId
        ? ((await prisma.question.findFirst({ where: { previousYearPaperId: otherId, paperQuestionNumber: reuse.question, retiredAt: null }, select })) ?? undefined)
        : undefined;
      sourceNote = `stored once as ${reuse.year} Q${reuse.question}`;
    }
    if (!row) {
      problems.push(`Q${n}: not in the question bank.`);
      continue;
    }
    // A reused question is printed in THIS booklet's option order (lib/fso-official.ts optionOrder).
    const options =
      reuse?.optionOrder && sourceNote.startsWith("stored once")
        ? reuse.optionOrder.map((k) => row!.options[k - 1]).filter(Boolean)
        : row.options;
    const flags: string[] = [];
    if (row.contentFormat !== "PLAIN") flags.push("rich-format");
    if (/\$|\\\(|\\\[/.test(row.text)) flags.push("math-markup");
    if (row.imageUrl || row._count.assets > 0 || row.options.some((o) => o.imageUrl)) flags.push("has-image(not printed)");
    if (options.length !== 4) problems.push(`Q${n}: ${options.length} options (expected 4).`);
    questions.push({
      number: n,
      questionId: row.id,
      sourceNote,
      status: row.status,
      en: row.text,
      hi: row.textHi,
      options: options.map((o) => ({ en: o.text, hi: o.textHi, isCorrect: o.isCorrect })),
      flags,
    });
  }
  return { questions, problems };
}

/** Which language versions the bank fully supports (EN always needs text; HI needs textHi on every question and option). */
export function supportedLangs(questions: PrintedQuestion[]): PaperPdfLang[] {
  const hasHi = questions.length > 0 && questions.every((q) => q.hi?.trim() && q.options.every((o) => o.hi?.trim()));
  const hasEn = questions.length > 0 && questions.every((q) => q.en.trim() && q.options.every((o) => o.en.trim()));
  return PAPER_PDF_LANGS.filter((l) => (l === "ENGLISH" ? hasEn : l === "HINDI" ? hasHi : hasEn && hasHi));
}

/** Stored answer (1-based option position) vs the official key, for every non-deleted question. */
export function keyMismatches(questions: PrintedQuestion[], facts: FsoPaperFacts): { number: number; stored: number; official: number }[] {
  const out: { number: number; stored: number; official: number }[] = [];
  for (const q of questions) {
    const official = facts.answers[q.number - 1];
    if (official === 0) continue; // deleted by RPSC: not scored, the bank's flag is irrelevant here
    const correct = q.options.flatMap((o, i) => (o.isCorrect ? [i + 1] : []));
    const stored = correct.length === 1 ? correct[0] : -1;
    if (stored !== official) out.push({ number: q.number, stored, official });
  }
  return out;
}

export function paperHtml(facts: FsoPaperFacts, questions: PrintedQuestion[], lang: PaperPdfLang): string {
  const font = (f: string) => `url("file://${path.join(FONT_DIR, f)}")`;
  const showHi = lang !== "ENGLISH";
  const showEn = lang !== "HINDI";
  const deleted = new Set(facts.deleted);
  const opts = (q: PrintedQuestion, l: "en" | "hi") =>
    `<ol class="opts">${q.options.map((o, i) => `<li><span class="on">(${i + 1})</span> ${para((l === "hi" ? o.hi : o.en) ?? "")}</li>`).join("")}</ol>`;
  const block = (q: PrintedQuestion) => {
    const del = deleted.has(q.number) ? `<div class="del">Deleted by RPSC in the official answer key — not scored</div>` : "";
    const hi = showHi ? `<div class="col hi" lang="hi">${para(q.hi ?? "")}${opts(q, "hi")}</div>` : "";
    const en = showEn ? `<div class="col en" lang="en">${para(q.en)}${opts(q, "en")}</div>` : "";
    return `<section class="q"><div class="qn">${q.number}.</div><div class="body">${del}<div class="cols ${lang === "BILINGUAL" ? "two" : ""}">${hi}${en}</div></div></section>`;
  };
  const keyCells = facts.answers
    .map((a, i) => `<td class="kq">${i + 1}</td><td class="ka">${a === 0 ? "Deleted" : a}</td>`)
    .reduce<string[][]>((rows, cell, i) => {
      if (i % 5 === 0) rows.push([]);
      rows[rows.length - 1].push(cell);
      return rows;
    }, [])
    .map((r) => `<tr>${r.join("")}</tr>`)
    .join("");
  const langLabel = PAPER_PDF_LANG_LABEL[lang];
  const englishPrevails = showHi ? `<li>In case of any difference between the Hindi and English versions, the English version prevails (as printed on the RPSC booklet).</li>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>RPSC FSO ${facts.year} — ${esc(langLabel)}</title><style>
@font-face{font-family:Body;src:${font("LiberationSans-Regular.ttf")};font-weight:400}
@font-face{font-family:Body;src:${font("LiberationSans-Bold.ttf")};font-weight:700}
@font-face{font-family:Deva;src:${font("NotoSansDevanagari-Regular.ttf")};font-weight:400}
@font-face{font-family:Deva;src:${font("NotoSansDevanagari-Bold.ttf")};font-weight:700}
@page{size:A4;margin:18mm 14mm 18mm 14mm}
html,body{margin:0}
*{box-sizing:border-box}
body{font-family:Body,Deva,sans-serif;font-size:10pt;line-height:1.38;color:#111}
.hi{font-family:Deva,Body,sans-serif}
.wm{position:fixed;color:#000;opacity:.07;font-weight:700;pointer-events:none;z-index:0;white-space:nowrap;font-family:Body,sans-serif}
.wm.h{top:46%;left:0;right:0;text-align:center;font-size:30pt}
.wm.d{top:40%;left:8%;font-size:46pt;transform:rotate(-35deg)}
.wm.v{top:30%;right:0;font-size:12pt;writing-mode:vertical-rl}
main{position:relative;z-index:1}
h1{font-size:15pt;margin:0 0 4mm}
.cover{border:1px solid #999;padding:6mm;margin-bottom:6mm}
.cover table{border-collapse:collapse;width:100%}
.cover td{padding:1.2mm 2mm;border-bottom:1px solid #ddd;vertical-align:top}
.cover td:first-child{width:38%;color:#444}
.note{font-size:8.5pt;color:#333}
.q{display:flex;gap:3mm;padding:2.2mm 0;border-bottom:1px solid #e3e3e3;break-inside:avoid}
.qn{font-weight:700;min-width:9mm}
.body{flex:1}
.cols.two{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.opts{list-style:none;margin:1.2mm 0 0;padding:0}
.opts li{margin:.6mm 0}
.on{font-weight:700}
.del{display:inline-block;font-size:8pt;font-weight:700;border:1px solid #b00;color:#b00;padding:.4mm 1.6mm;margin-bottom:1.2mm}
.key{border-collapse:collapse;width:100%;table-layout:fixed;font-size:9pt;break-inside:auto}
.key td{border:1px solid #bbb;padding:1mm 1.5mm;text-align:center}
.kq{background:#f3f3f3;font-weight:700}
.pb{break-before:page}
a{color:#0645ad}
</style></head><body>
<div class="wm h">mocktestseries.in</div><div class="wm d">mocktestseries.in</div><div class="wm v">mocktestseries.in</div>
<main>
<div class="cover">
<h1>RPSC Food Safety Officer — ${facts.year} Question Paper (${esc(langLabel)})</h1>
<table>
<tr><td>Examination</td><td>${esc(facts.examName)}</td></tr>
<tr><td>Conducted by</td><td>Rajasthan Public Service Commission (RPSC), Ajmer</td></tr>
<tr><td>Booklet</td><td>${esc(facts.bookletCode)}</td></tr>
<tr><td>Held on</td><td>${esc(facts.heldOn)}</td></tr>
<tr><td>Questions / marks</td><td>${facts.totalQuestions} questions, ${facts.totalMarks} marks</td></tr>
<tr><td>Time</td><td>${Math.floor(facts.durationMinutes / 60)} h${facts.durationMinutes % 60 ? ` ${facts.durationMinutes % 60} min` : ""}</td></tr>
<tr><td>Negative marking</td><td>${esc(facts.negativeMarking)}</td></tr>
<tr><td>Answer key used</td><td>${esc(facts.keyLabel)}</td></tr>
<tr><td>Deleted by RPSC</td><td>${facts.deleted.length ? facts.deleted.map((n) => `Q${n}`).join(", ") : "None"}</td></tr>
</table>
<ul class="note"><li>Options are numbered 1, 2, 3, 4 as in the RPSC booklet.</li>${englishPrevails}<li>Typeset by mocktestseries.in from its question bank. This is not an official RPSC document; see the last page for sources.</li></ul>
</div>
${questions.map(block).join("\n")}
<div class="pb"></div>
<h1>Answer key — ${esc(facts.keyLabel)}</h1>
<p class="note">"Deleted" = deleted by RPSC in the official answer key (not scored).</p>
<table class="key">${keyCells}</table>
<div class="pb"></div>
<h1>Sources and attribution</h1>
<p>Questions from the RPSC Food Safety Officer examination booklet ${esc(facts.bookletCode)} (held ${esc(facts.heldOn)}), published by the Rajasthan Public Service Commission, Ajmer, on <a href="https://rpsc.rajasthan.gov.in/">rpsc.rajasthan.gov.in</a>. Answer key: ${esc(facts.keyLabel)}.</p>
<p>Typeset by <a href="${SITE}">mocktestseries.in</a> for exam practice. This is not an official RPSC document. In any difference, the official RPSC documents prevail.</p>
<ul class="note">${facts.sources.map((s) => `<li>${esc(s.label)} — SHA-256 ${s.sha256}</li>`).join("")}</ul>
</main></body></html>`;
}

/** Clickable mocktestseries.in link over the footer text of every page (Chromium footer templates are not clickable). */
async function addFooterLinks(bytes: Uint8Array): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [36, 14, 200, 34],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(SITE) },
    });
    page.node.addAnnot(doc.context.register(annot));
  }
  doc.setTitle(doc.getTitle() ?? "RPSC FSO question paper");
  doc.setProducer("mocktestseries.in");
  return { bytes: await doc.save(), pages: doc.getPageCount() };
}

export async function renderPdf(html: string, headerLabel: string): Promise<Uint8Array> {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  // Resolved from NODE_PATH (an existing local Playwright install); not an app dependency.
  const { chromium } = require("playwright") as {
    chromium: {
      launch(): Promise<{
        newPage(): Promise<{
          setContent(html: string, o: { waitUntil: "load" }): Promise<void>;
          evaluate<T>(fn: () => T): Promise<unknown>;
          pdf(o: Record<string, unknown>): Promise<Uint8Array>;
        }>;
        close(): Promise<void>;
      }>;
    };
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const style = `font-family:Arial,sans-serif;font-size:8px;color:#555;width:100%;padding:0 14mm;display:flex;justify-content:space-between`;
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="${style}"><span>${esc(headerLabel)}</span><span>mocktestseries.in</span></div>`,
      footerTemplate: `<div style="${style}"><span>mocktestseries.in</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: "18mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.examCode) throw new Error("--exam-code is required (e.g. RUHS-FSO)");
  const exam = await prisma.exam.findUnique({ where: { code: args.examCode }, select: { id: true, code: true } });
  if (!exam) throw new Error(`Exam ${args.examCode} not found`);
  mkdirSync(args.out, { recursive: true });
  const years = args.year ? [args.year] : (Object.keys(FSO_PAPERS).map(Number) as number[]);
  let failed = false;
  for (const year of years) {
    const facts = fsoPaperFacts(year);
    if (!facts) throw new Error(`No official facts for ${year}`);
    const { questions, problems } = await loadPrintedQuestions(exam.id, facts);
    const mismatches = keyMismatches(questions, facts);
    const langs = supportedLangs(questions).filter((l) => !args.lang || l === args.lang);
    const csv = [
      "printed_no,question_id,source,status,has_hindi,official_key,stored_answer,key_match,flags",
      ...questions.map((q) => {
        const off = facts.answers[q.number - 1];
        const mm = mismatches.find((m) => m.number === q.number);
        return [q.number, q.questionId, q.sourceNote, q.status, q.hi ? "yes" : "no", off === 0 ? "deleted" : off, mm ? mm.stored : off === 0 ? "-" : off, mm ? "MISMATCH" : "ok", q.flags.join(" ")].join(",");
      }),
    ].join("\n");
    writeFileSync(path.join(args.out, `provenance-${args.examCode}-${year}.csv`), csv + "\n");
    console.log(`${year}: ${questions.length}/${facts.totalQuestions} questions; problems ${problems.length}; key mismatches ${mismatches.length}; versions ${langs.join(", ") || "none"}`);
    problems.forEach((p) => console.log(`  problem: ${p}`));
    mismatches.forEach((m) => console.log(`  key mismatch: Q${m.number} stored ${m.stored} official ${m.official}`));
    if (problems.length || questions.length !== facts.totalQuestions || (mismatches.length && !args.allowKeyMismatch)) {
      console.log(`  ${year}: NOT BUILT (fix the bank or review the provenance CSV).`);
      failed = true;
      continue;
    }
    const paper = await prisma.previousYearPaper.findFirst({ where: { examId: exam.id, year }, select: { id: true } });
    for (const lang of langs) {
      const html = paperHtml(facts, questions, lang);
      const raw = await renderPdf(html, `RPSC FSO ${year} · ${PAPER_PDF_LANG_LABEL[lang]}`);
      const { bytes, pages } = await addFooterLinks(raw);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(path.join(args.out, `RPSC-FSO-${year}-${lang}.pdf`), bytes);
      if (args.dryRun) {
        console.log(`  ${lang}: ${pages} pages, sha ${sha256.slice(0, 12)} (dry run: not stored)`);
        continue;
      }
      const fileUrl = await saveGeneratedResourcePdf(bytes);
      const resource = await prisma.testResource.create({
        data: {
          type: "PAPER_PDF",
          title: `RPSC FSO ${year} — ${PAPER_PDF_LANG_LABEL[lang]}`,
          fileUrl,
          mimeType: "application/pdf",
          fileSizeBytes: bytes.length,
          questionCount: questions.length,
          isActive: false,
          examId: exam.id,
        },
      });
      await upsertPaperPdfEntry(exam.id, { paperId: paper!.id, year, lang, resourceId: resource.id, sha256, pages, questionCount: questions.length, builtAt: new Date().toISOString() });
      await prisma.auditLog.create({ data: { action: "PAPER_PDF_BUILT", entityType: "TestResource", entityId: resource.id, metadata: { examId: exam.id, year, lang, sha256, pages } } });
      console.log(`  ${lang}: ${pages} pages, sha ${sha256.slice(0, 12)} → resource ${resource.id} (inactive)`);
    }
  }
  await prisma.$disconnect();
  if (failed) process.exitCode = 1;
}

// Only when executed directly (the verification suite imports the helpers above).
if (process.argv[1] && /build-paper-pdfs\.ts$/.test(process.argv[1])) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
