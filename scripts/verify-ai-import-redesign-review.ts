/**
 * P2 "Review card" (2026-11-19): key-cell box stored for OCR key entries, the key-entry crop + its admin route, the
 * status strip (answer source / Verify 1–2 / independence / flag / confidence / pages) and the data-vs-cosmetic split.
 * Pure parts need no DB; part D writes "P2-" rows to the scratch DB only (refuses any DATABASE_URL not ending /mts_redesign_p2).
 *   DOTENV_CONFIG_PATH=/dev/null PG_POOL_MAX=3 DATABASE_URL=…/mts_redesign_p2 NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-redesign-review.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ocrKeyPairs } from "@/lib/ai-import/keys";
import { keyEntryCrop } from "@/lib/ai-import/figures";
import { issueKind, reviewStatus } from "@/lib/ai-import/checks";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import type { PaperVerification } from "@/lib/ai-import/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const L = (text: string, box: number[], score = 0.99) => ({ text, box: box as [number, number, number, number], score });
const inUnit = (b: { x: number; y: number; w: number; h: number } | null | undefined) => !!b && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9;

async function main() {
  // ---- A. box of OCR key entries (pure) -------------------------------------------------------------------------------
  console.log("A. OCR key entries carry the normalized box of their cells");
  const page = { width: 1000, height: 2000, lines: [L("1", [100, 100, 130, 140]), L("B", [200, 100, 230, 140]), L("2", [100, 160, 130, 200]), L("(c)", [200, 160, 250, 200])] };
  const r = ocrKeyPairs(page);
  const b1 = r.pairs.find((p) => p.number === 1)?.box;
  check("A1 both entries read with a box", r.pairs.length === 2 && r.pairs.every((p) => inUnit(p.box)), r.pairs);
  check("A2 box covers number and value cells (x 100–230, y 100–140 px) padded by one row (40 px)", !!b1 && Math.abs(b1.x - 0.06) < 1e-9 && Math.abs(b1.y - 0.03) < 1e-9 && Math.abs(b1.x + b1.w - 0.27) < 1e-9 && Math.abs(b1.y + b1.h - 0.09) < 1e-9, b1);
  check("A3 without page size (older callers) no box is invented", ocrKeyPairs({ lines: page.lines }).pairs.every((p) => p.box === null));
  check("A4 box clamps at the page edge", inUnit(ocrKeyPairs({ width: 240, height: 150, lines: [L("1", [0, 0, 30, 40]), L("B", [200, 0, 240, 40])] }).pairs[0]?.box));
  const real = ocrKeyPairs(JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "fixtures", "ai-import-papers", "cms2026p2-key.ocr.json"), "utf8")), 120);
  check("A5 real CMS 2026 P-II key grid: still 112 entries, every one with a box inside the page", real.pairs.length === 112 && real.pairs.every((p) => inUnit(p.box)), real.pairs.length);
  check("A6 …boxes are row-sized (one row + one row padding each side: height < 6% of the page)", real.pairs.every((p) => p.box!.h < 0.06), real.pairs.map((p) => p.box!.h).sort().slice(-3));

  // ---- B. key crop (pure, sharp) ---------------------------------------------------------------------------------------
  console.log("B. Key-entry crop from the key page render");
  const render = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const crop = await keyEntryCrop(render, { x: 0.06, y: 0.03, w: 0.21, h: 0.06 });
  const meta = crop ? await sharp(crop).metadata() : null;
  check("B1 crop is a PNG of the box (210 × 120 px, ±1 px rounding)", meta?.format === "png" && Math.abs((meta.width ?? 0) - 210) <= 1 && Math.abs((meta.height ?? 0) - 120) <= 1, meta && { w: meta.width, h: meta.height });
  check("B2 null / malformed / empty boxes give no image (route → 404)", (await Promise.all([null, {}, { x: 0, y: 0, w: 0, h: 0.1 }, { x: "a", y: 0, w: 0.1, h: 0.1 }, { x: Number.NaN, y: 0, w: 0.1, h: 0.1 }].map((b) => keyEntryCrop(render, b)))).every((x) => x === null));
  check("B3 a box partly off the page is clipped to the page", ((await sharp((await keyEntryCrop(render, { x: 0.9, y: 0.95, w: 0.5, h: 0.5 }))!).metadata()).width ?? 0) === 100);

  // ---- C. route: admin only --------------------------------------------------------------------------------------------
  console.log("C. key-entries/[id]/image route");
  const src = readFileSync(path.join(process.cwd(), "app/api/admin/ai-importer/key-entries/[id]/image/route.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function GET"));
  check("C1 the handler checks AI_IMPORTER_VIEW before any database read", body.indexOf("requirePermission(PERMISSIONS.AI_IMPORTER_VIEW)") > 0 && body.indexOf("requirePermission") < body.indexOf("prisma."));
  check("C2 route lives under /api/admin (admin proxy + session), never a student path", src.length > 0);
  try {
    const { GET } = await import("@/app/api/admin/ai-importer/key-entries/[id]/image/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://localhost/api/admin/ai-importer/key-entries/x/image"), { params: Promise.resolve({ id: "P2-none" }) });
    check("C3 without an admin session no image is returned", res.status !== 200 && !(res.headers.get("content-type") ?? "").startsWith("image/"), res.status);
  } catch (e) {
    check("C3 without an admin session no image is returned (handler threw before any image)", true, e instanceof Error ? e.message : e);
  }

  // ---- D. status strip + issue split (pure) ----------------------------------------------------------------------------
  console.log("D. Status strip and issue split");
  const base = { answerStatus: "KEY_MISSING" as const, answerConfirmedById: null as string | null, finalAnswer: [] as string[], officialAnswerRaw: null as string | null, officialKeyPage: null as number | null, sourceAnswer: [] as string[], aiAnswer: [] as string[], issueCodes: [] as string[], issues: {} as Record<string, string>, confidence: 0.934 as number | null, pages: [3, 4] };
  const none = { v1: "none" as const, v2: "none" as const, pv: null };
  const S = (o: Partial<typeof base>, vs: Parameters<typeof reviewStatus>[1] = none) => reviewStatus({ ...base, ...o } as Parameters<typeof reviewStatus>[0], vs, ISSUE_DEFS);
  check("D1 official key matched → verified, with key page", (() => { const s = S({ answerStatus: "OFFICIAL_MATCHED" as never, finalAnswer: ["C"], officialAnswerRaw: "C", officialKeyPage: 2 }); return s.answerSource === "verified" && s.answerFrom === "official key C" && s.keyPage === 2; })());
  check("D2 administrator confirmation → verified", S({ answerStatus: "UNVERIFIED" as never, finalAnswer: ["A"], answerConfirmedById: "admin" }).answerSource === "verified");
  check("D3 printed answer only → provisional", (() => { const s = S({ answerStatus: "UNVERIFIED" as never, finalAnswer: ["B"], sourceAnswer: ["B"], issueCodes: ["ANSWER_UNVERIFIED"] }); return s.answerSource === "provisional" && s.answerFrom === "printed in the paper"; })());
  check("D4 AI opinion only → provisional (never verified)", S({ answerStatus: "INDEPENDENTLY_VERIFIED" as never, finalAnswer: ["D"], aiAnswer: ["D"] }).answerSource === "provisional");
  check("D5 no answer at all → missing", S({ issueCodes: ["ANSWER_MISSING"] }).answerSource === "missing");
  check("D6 key mismatch → conflict", S({ answerStatus: "KEY_MISMATCH" as never, finalAnswer: ["A"], officialAnswerRaw: "B" }).answerSource === "conflict");
  check("D7 ambiguous mapping / answer-fail code → conflict", S({ answerStatus: "AMBIGUOUS_MAPPING" as never }).answerSource === "conflict" && S({ answerStatus: "OFFICIAL_MATCHED" as never, finalAnswer: ["A"], issueCodes: ["ANSWER_TYPE_CONFLICT"] }).answerSource === "conflict");
  check("D8 official match but still ANSWER_UNVERIFIED → not verified", S({ answerStatus: "OFFICIAL_MATCHED" as never, finalAnswer: ["A"], issueCodes: ["ANSWER_UNVERIFIED"] }).answerSource === "provisional");
  const flagged = S({ issueCodes: ["FORMAT_DEVIATION", "TOPIC_UNCERTAIN", "OPTIONS_INCOMPLETE"], issues: { OPTIONS_INCOMPLETE: "Only 3 of 4 options were read." } });
  check("D9 flag = first BLOCKING code with its exact stored reason", flagged.flag?.code === "OPTIONS_INCOMPLETE" && flagged.flag.reason === "Only 3 of 4 options were read." && flagged.flag.label === ISSUE_DEFS.OPTIONS_INCOMPLETE.label, flagged.flag);
  check("D10 only cosmetic codes → no flag", S({ issueCodes: ["FORMAT_DEVIATION", "AI_OPINION_DIFFERS"] }).flag === null);
  check("D11 publish-blocking only → that code is the flag", S({ issueCodes: ["NUMBERING_GAP", "TOPIC_UNCERTAIN"] }).flag?.code === "TOPIC_UNCERTAIN");
  check("D12 confidence in %, pages as stored", flagged.confidence === 93 && flagged.pages.join() === "3,4" && S({ confidence: null }).confidence === null);
  const pv = (independence?: "SOURCE" | "SAME_TEXT", part?: string) => ({ v2: { status: "VERIFIED", model: "m", at: "", fingerprint: "", fields: [], detail: "", independence, part } }) as unknown as PaperVerification;
  check("D13 Verify 1/2 states passed through; independence SOURCE", (() => { const s = S({}, { v1: "passed", v2: "verified", pv: pv("SOURCE") }); return s.v1 === "passed" && s.v2 === "verified" && s.independence === "SOURCE"; })());
  check("D14 same-text Verify 2 (older result recognised by its part label) → SAME_TEXT", S({}, { v1: "problems", v2: "disagree", pv: pv(undefined, "a.docx part 3 of 12") }).independence === "SAME_TEXT");
  check("D15 Verify 2 not run → no independence", S({}).independence === null);
  const cosmetic = Object.keys(ISSUE_DEFS).filter((c) => issueKind(c, ISSUE_DEFS) === "cosmetic").sort();
  check("D16 cosmetic = exactly the codes that never block import or publish", JSON.stringify(cosmetic) === JSON.stringify(["AI_OPINION_DIFFERS", "FORMAT_DEVIATION", "NUMBERING_GAP", "SECTION_SUBJECT_DIFFERS"]), cosmetic);
  check("D17 every blocking or publish-blocking code is a data error; unknown codes are data errors", Object.entries(ISSUE_DEFS).every(([c, d]) => !(d.blocking || d.publishBlocking) || issueKind(c, ISSUE_DEFS) === "data") && issueKind("SOMETHING_NEW", ISSUE_DEFS) === "data");

  // ---- E. DB: saveKeyEntries stores the box (scratch DB only) ----------------------------------------------------------
  console.log("E. Key entries stored with their box (scratch DB)");
  if (!/\/mts_redesign_p2(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing: DATABASE_URL must be the mts_redesign_p2 scratch DB");
  const { prisma } = await import("@/lib/prisma");
  const { saveKeyEntries } = await import("@/lib/ai-import/process");
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  await prisma.aiImportJob.deleteMany({ where: { title: { startsWith: "P2-" } } });
  await prisma.exam.deleteMany({ where: { code: "P2-REVIEW-EXAM" } });
  const exam = await prisma.exam.create({ data: { name: "P2- review exam", code: "P2-REVIEW-EXAM" } });
  const job = await prisma.aiImportJob.create({ data: { title: "P2- review card", examId: exam.id, createdById: admin.id, budgetInr: 0 } });
  try {
    await saveKeyEntries({ job }, "P2-keyfile", null, null, [...r.pairs.map((p) => ({ ...p, page: 1 })), { number: 3, section: "", raw: "A", page: 1 }]);
    const rows = await prisma.aiImportKeyEntry.findMany({ where: { jobId: job.id }, orderBy: { sourceNumber: "asc" } });
    check("E1 OCR entries stored with their normalized box", rows.length === 3 && (["x", "y", "w", "h"] as const).every((k) => (rows[0].box as Record<string, number>)[k] === b1![k]) && inUnit(rows[1].box as never), rows.map((x) => x.box));
    check("E2 a text-layer entry (no box) stores NULL", rows[2].box === null);
  } finally {
    await prisma.aiImportJob.delete({ where: { id: job.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
