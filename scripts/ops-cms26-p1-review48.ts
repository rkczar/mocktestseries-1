/**
 * Review of the 48 open Verify 2 disagreements (2026-11-20, job cmwoezrtp00wt8dkz0olhkbo2) against the printed pages
 * (evidence /root/mts-evidence/key-integrity-deploy/pages). Text fixes = OCR defects visible on the page; resolutions =
 * the stored text matches the page and the second read was wrong (audited, never an approval). No answer is set,
 * nothing is approved / imported / published / deleted.
 *   ACTOR=<admin id> [--apply --confirm=cmwoezrtp00wt8dkz0olhkbo2]
 */
import { prisma } from "@/lib/prisma";
import { cropFigureFromPage, editQuestion, resolveVerify2Disagreement, revalidateQuestions } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";
import { runVerify1 } from "@/lib/ai-import/paper-verify";

const J = "cmwoezrtp00wt8dkz0olhkbo2";
const ACTOR = process.env.ACTOR ?? "";
const apply = process.argv.includes("--apply") && process.argv.includes(`--confirm=${J}`);
type Fix = { stem?: [RegExp, string][]; stemAll?: string; instructions?: string; options?: string[]; note: string };
const FIX: Record<number, Fix> = {
  7: { stem: [[/Grade 3\s+Grade 4/, "Grade 3\n4. Grade 4"]], note: "page 3: statement 4 number" },
  27: { stem: [[/The\s+13C-urea breath test'\s+and the\s+faecal antigen test'/, "The ‘¹³C-urea breath test’ and the ‘faecal antigen test’"]], note: "page 7: quotation marks and superscript 13 (option (a) 'inftuenzae' kept as printed)" },
  34: { stem: [[/condition\s*\?\s*Little\/no proteinuria/, "condition ?\n1. Little/no proteinuria"]], note: "page 8: statement 1 number" },
  50: { stem: [[/Exudative maculopathy\s+Acanthosis nigricans/, "Exudative maculopathy\n4. Acanthosis nigricans"]], note: "page 11: statement 4 number" },
  53: { stem: [[/whichof/, "which of"], [/1\.\s*Phosphate\s+2\.\s*Magnesium\s+Sodium\s+Potassium/, "1. Phosphate\n2. Magnesium\n3. Sodium\n4. Potassium"]], note: "page 12: joined words, statement 3/4 numbers" },
  57: { stem: [[/1\.\s*Octreotide\s+Lanreotide\s+3\.\s*Pasireotide\s+Pegvisomant/, "1. Octreotide\n2. Lanreotide\n3. Pasireotide\n4. Pegvisomant"]], note: "page 12: statement 2/4 numbers" },
  70: { stem: [[/acrossthe/, "across the"]], note: "page 14: joined words" },
  80: { stem: [[/Whichof/, "Which of"], [/Hydroxychloroquine\s+Leflunomide/, "Hydroxychloroquine\n4. Leflunomide"]], note: "page 16: joined words, statement 4 number" },
  83: { stem: [[/Withregard/, "With regard"]], note: "page 17: joined words" },
  84: { stem: [[/point mutations\s*:\s*If a purine/, "point mutations :\n1. If a purine"]], note: "page 17: statement 1 number" },
  89: { stemAll: "Which of the following pairs of parasites and associated clinical manifestations are correct ?\n1. Ancylostoma duodenale : Anemia\n2. Ascaris lumbricoides : Löffler Syndrome\n3. Loa loa : Katayama Fever\n4. Trichinella spiralis : Myositis\nSelect the answer using the code given below :", note: "page 18: pairs list rebuilt as printed" },
  91: { stem: [[/shown below\s*:\s*$/, "shown below :\nHaemoglobin – 10 g/dL\nPeripheral smear – Microcytic hypochromic picture with anisocytosis\nReticulocyte count – 5%\nSerum ferritin – 300 microgram/L\nWhat is the most likely underlying diagnosis ?"]], instructions: "", note: "page 19: investigation values and the question restored (question line was stored as instructions)" },
  94: { options: ["A-2, B-3, C-4, D-1", "A-2, B-4, C-3, D-1", "A-1, B-3, C-4, D-2", "A-1, B-4, C-3, D-2"], note: "page 19: the four printed answer codes" },
  107: { stem: [[/motordomain/, "motor domain"], [/\s*A\.\s*B\.\s*$/, ""]], note: "page 22: joined words; structure labels A / B are in the figure" },
};
const CROP: Record<number, { page: number; box: { x: number; y: number; w: number; h: number }; note: string }> = {
  107: { page: 22, box: { x: 0.548, y: 0.203, w: 0.27, h: 0.212 }, note: "Structures A and B" },
  110: { page: 23, box: { x: 0.064, y: 0.496, w: 0.378, h: 0.238 }, note: "abdominal X-ray" },
};
const R = {
  punct: "Compared with the printed page: stored stem and options match; the second read differs only in punctuation / quotation marks / spacing.",
  partial: "Compared with the printed page: stored stem and options match; the second read returned only part of the question text.",
  latex: "Compared with the printed page: stored text matches; the second read only wrote the same symbol / italics as LaTeX.",
  wrong: "Compared with the printed page: stored stem and options match the print; the second read is wrong (merged statements into options, dropped or changed words / numbers).",
};
const RESOLVE: Record<number, string> = {
  11: R.punct, 12: R.punct, 19: R.punct, 20: R.punct, 21: R.punct, 39: R.punct, 79: R.punct,
  15: R.partial, 17: R.partial, 18: R.partial, 92: R.partial, 93: R.partial, 16: R.partial,
  28: R.latex, 59: R.latex, 73: R.latex,
  24: R.wrong, 41: R.wrong, 43: R.wrong, 54: R.wrong, 56: R.wrong, 67: R.wrong, 77: R.wrong, 81: R.wrong, 82: R.wrong,
  99: `${R.wrong} Page 21 prints serum potassium 6·5 mEq/L (second read 3.5).`, 100: R.wrong, 103: R.wrong, 119: R.wrong,
  120: `${R.wrong} Page 24 prints 'previously unimmunized' (second read 'immunized').`,
};

void (async () => {
  if (!ACTOR) throw new Error("set ACTOR");
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: J, NOT: { status: "IMPORTED" } } });
  const by = new Map(rows.map((q) => [q.sourceNumber!, q]));
  const problems: string[] = [];
  const planned: Record<number, { stem: string; instructions?: string; options: string[] }> = {};
  for (const [k, f] of Object.entries(FIX)) {
    const n = Number(k), q = by.get(n);
    if (!q) { problems.push(`Q${n} missing`); continue; }
    const e = effective(q);
    let stem = f.stemAll ?? e.stem;
    for (const [re, rep] of f.stem ?? []) {
      const hits = (e.stem.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
      if (hits !== 1) problems.push(`Q${n}: ${re} matched ${hits}×`);
      stem = stem.replace(re, rep);
    }
    if (f.options && f.options.length !== e.options.length) problems.push(`Q${n}: option count`);
    planned[n] = { stem, instructions: f.instructions, options: f.options ?? e.options.map((o) => o.text) };
  }
  for (const k of Object.keys(RESOLVE)) {
    const n = Number(k), q = by.get(n);
    const st = (effective(q!) as { paperVerify?: { v2?: { status?: string } } }).paperVerify?.v2?.status;
    if (!q || !q.issueCodes.includes("VERIFY2_DISAGREES") || !["DISAGREE", "NOT_FOUND"].includes(st ?? "")) problems.push(`Q${n}: no open V2 disagreement (${st})`);
    if (FIX[n]) problems.push(`Q${n}: both fixed and resolved`);
  }
  for (const k of Object.keys(CROP)) if ((await prisma.aiImportFigure.count({ where: { questionId: by.get(Number(k))!.id } })) !== 0) problems.push(`Q${k} already has a figure`);
  console.log(JSON.stringify({ fixes: Object.keys(FIX).length, crops: Object.keys(CROP).length, resolutions: Object.keys(RESOLVE).length, problems, preview: Object.fromEntries(Object.entries(planned).map(([n, p]) => [n, p.stem.replace(/\n/g, " ⏎ ").slice(-160)])) }, null, 1));
  if (problems.length) throw new Error("precondition failed — nothing changed");
  if (!apply) return console.log("DRY RUN — nothing changed.");
  for (const [k, p] of Object.entries(planned)) {
    const q = by.get(Number(k))!, e = effective(q);
    await editQuestion(q.id, ACTOR, { stem: p.stem, options: e.options.map((o, i) => ({ label: o.label, text: p.options[i] })), type: e.type, contentFormat: (e.contentFormat ?? "PLAIN") as "PLAIN" | "RICH_V1", ...(p.instructions !== undefined ? { instructions: p.instructions } : {}) }, { note: `checked against the printed ${FIX[Number(k)].note}` });
  }
  for (const [k, c] of Object.entries(CROP)) await cropFigureFromPage({ questionId: by.get(Number(k))!.id, actorId: ACTOR, pageNumber: c.page, box: c.box, owner: "STEM", optionLabel: null, replaceFigureId: null });
  for (const [k, why] of Object.entries(RESOLVE)) await resolveVerify2Disagreement(by.get(Number(k))!.id, ACTOR, why);
  await revalidateQuestions(J, rows.map((q) => q.id));
  const v1 = await runVerify1(J, ACTOR);
  console.log("APPLIED; Verify 1:", v1.questions, v1.passed, v1.withProblems);
})()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
