/**
 * Paper-format regression suite of the AI Question Importer (no database, no AI, no network).
 *
 * Runs the importer's own readers against the ORIGINAL examination papers that failed (CMS 2013 Paper I / II, CMS 2024
 * Paper I / II) and the two that were imported correctly (CMS 2025 Paper I / II), and checks them against truth read from
 * the original paper and key files (scripts/fixtures/ai-import-papers/truth.json): extraction completeness, numbering,
 * option boundaries, section headings, printed answer marks and annotations, official-key layouts, the number-sequence
 * guard of AI-read pages, instruction items, question formats, paper-format memory and verification fingerprints.
 *
 *   AI_IMPORT_PAPER_FIXTURES=<folder with the original files> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-paper-formats.ts
 *
 * The paper files are not committed; without the folder the original-file checks are reported as NOT RUN (a failure).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readDocx } from "@/lib/ai-import/docx";
import { blockToQuestion, candidateInstruction, numberSequenceProblems, questionFormats, splitQuestions, takePrintedAnswer, detectType } from "@/lib/ai-import/local-parse";
import { keyReadingIncomplete, parseKeyText, KEY_MIN_COVERAGE } from "@/lib/ai-import/keys";
import { confirmedSubjectScope, generalize, learnPaperRules, mergePaperRules, ocrPairs, paperOf, type LearnInput, type PaperRule } from "@/lib/ai-import/paper-memory";
import { fingerprintsOf, verifyState } from "@/lib/ai-import/verify-core";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}

type Paper = { file: string; sha256: string; kind: string; paper: string; year: number; officialKey?: Record<string, string>; sourceMarks?: Record<string, string | null>; sourceMarkContradictsKey?: number[]; index?: Record<string, { page: number; opening: string }>; storedReads?: { page: number; number: number | null; printedNumber: number | null; options: number; method: string; sourceNumber: number | null; note?: string }[] };
const truth = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/fixtures/ai-import-papers/truth.json"), "utf8")) as { papers: Record<string, Paper> };
const DIR = process.env.AI_IMPORT_PAPER_FIXTURES ?? "";
const MARK = /[✓✔☑■]|Correct Answer|Official Answer/;

/** The importer's Word reading of one paper (same rules as extraction: lib/ai-import/process.ts docxQuestions). */
async function readPaper(p: Paper): Promise<(ExtractedQuestion & { heading: string | null })[] | null> {
  const f = path.join(DIR, p.file);
  if (!DIR || !existsSync(f)) return null;
  const doc = await readDocx(f);
  return splitQuestions(doc.lines).blocks.map((b) => ({ ...blockToQuestion(b, 1, "DOCX").q, heading: b.heading ?? null }));
}

async function main() {
  section("Original Word papers — completeness, numbering, options, marks");
  const read = new Map<string, (ExtractedQuestion & { heading: string | null })[]>();
  for (const [id, p] of Object.entries(truth.papers).filter(([, p]) => p.kind === "docx")) {
    const qs = await readPaper(p);
    if (!qs) {
      check(`${id}: original file available (${p.file})`, false, `set AI_IMPORT_PAPER_FIXTURES — NOT RUN`);
      continue;
    }
    read.set(id, qs);
    check(`${id}: 120 questions extracted`, qs.length === 120, qs.length);
    check(`${id}: numbered 1–120 in order, no false section restart`, qs.map((q) => q.number).join() === Array.from({ length: 120 }, (_, i) => i + 1).join() && qs.every((q) => q.section === ""), qs.map((q) => `${q.section}${q.number}`).slice(0, 40));
    check(`${id}: every question has 4 non-empty options`, qs.every((q) => q.options.length === 4 && q.options.every((o) => o.text.trim())), qs.filter((q) => q.options.length !== 4 || q.options.some((o) => !o.text.trim())).map((q) => [q.number, q.options.length]));
    check(`${id}: no answer mark / annotation left in a stem or option`, qs.every((q) => !MARK.test(q.stem) && q.options.every((o) => !MARK.test(o.text))), qs.filter((q) => MARK.test(q.stem) || q.options.some((o) => MARK.test(o.text))).map((q) => q.number));
    const marks = p.sourceMarks ?? {};
    const wrong = qs.filter((q) => (marks[String(q.number)] ?? null) !== (q.printedAnswer[0] ?? null) || q.printedAnswer.length > 1);
    check(`${id}: printed answer = the mark printed in the source, for every question`, !wrong.length, wrong.map((q) => [q.number, q.printedAnswer, marks[String(q.number)]]));
    check(`${id}: no question read as an instruction to candidates`, !qs.some((q) => candidateInstruction(q)), qs.filter((q) => candidateInstruction(q)).map((q) => q.number));
    const again = await readPaper(p);
    check(`${id}: reading the same file twice gives the same questions (repeatable)`, JSON.stringify(again) === JSON.stringify(qs));
    if (p.officialKey) {
      const key = p.officialKey;
      const contradict = qs.filter((q) => q.printedAnswer.length && key[String(q.number)] !== "X" && !key[String(q.number)].split("/").includes(q.printedAnswer[0])).map((q) => q.number);
      check(`${id}: printed marks that contradict the official key are exactly the source's (${p.sourceMarkContradictsKey!.length})`, contradict.join() === p.sourceMarkContradictsKey!.join(), { contradict, expected: p.sourceMarkContradictsKey });
      const dropped = Object.entries(key).filter(([, v]) => v === "X").map(([n]) => Number(n));
      check(`${id}: the dropped item (${dropped.join(", ")}) prints no answer`, dropped.every((n) => !qs.find((q) => q.number === n)!.printedAnswer.length));
    }
  }
  const p13a = read.get("cms-2013-p1");
  if (p13a) {
    check("2013 Paper I: Q1 = C (selenium, as printed) and keeps option D (chromium)", p13a[0].printedAnswer.join() === "C" && p13a[0].options[3].text === "chromium", p13a[0]);
    check("2013 Paper I: Q14's statements (1. Granular casts …) stay in Q14, Q15 follows", /1\. Granular casts/.test(p13a[13].stem) && p13a[14].number === 15);
    check("2013 Paper I: Q24's List II (1. Coxiella burnetti …) stays in Q24", /Coxiella burnetti/.test(p13a[23].stem) && p13a[24].number === 25);
    check("2013 Paper I: no section headings (the “A B C D” code-table header is not one) and Q24 keeps it", p13a.every((q) => !q.heading) && /\nCode :\nA B C D$/.test(p13a[23].stem), [...new Set(p13a.map((q) => q.heading))]);
    check("2013 Paper I: 9 Match-the-List questions recognized", p13a.filter((q) => q.type === "MATCH_THE_FOLLOWING").length === 9, p13a.filter((q) => q.type === "MATCH_THE_FOLLOWING").map((q) => q.number));
    check("2013 Paper I: Q3 (… cyanosis except) is a negative-stem question", questionFormats(p13a[2]).includes("NEGATIVE_STEM"), questionFormats(p13a[2]));
  }
  const p13b = read.get("cms-2013-p2");
  if (p13b) check("2013 Paper II: Q88 (“more than one route of transmission”) stays single-correct", p13b[87].type === "SINGLE_CORRECT", p13b[87].type);
  const p25b = read.get("cms-2025-p2");
  if (p25b) {
    const heads = p25b.map((q) => q.heading);
    check("2025 Paper II: “■ SECTION” headings recognized — SURGERY Q1–40, G&O Q41–80, PSM Q81–120", heads.slice(0, 40).every((h) => h === "SURGERY") && heads.slice(40, 80).every((h) => h === "GYNAECOLOGY & OBSTETRICS") && heads.slice(80).every((h) => h === "PREVENTIVE & SOCIAL MEDICINE"), [...new Set(heads)]);
    check("2025 Paper II: no heading stored as an explanation", p25b.every((q) => !/SECTION/.test(q.hints?.explanation ?? "")));
    check("2025 Paper II: “✓ Correct Answer: (b) …” taken as the printed answer of all 120", p25b.every((q) => q.printedAnswer.length === 1 && /^✓/.test(q.printedAnswerRaw ?? "")));
    check("2025 Paper II: <w:br w:type=\"textWrapping\"/> keeps statements on their own lines (Q2 has I.–IV.)", /\nI\. Screening test[\s\S]*\nIV\. Disease/.test(p25b[1].stem), p25b[1].stem);
    check("2025 Paper II: statement-code questions recognized", p25b.filter((q) => questionFormats(q).includes("STATEMENT_CODE")).length >= 20);
  }
  const p25a = read.get("cms-2025-p1");
  if (p25a) check("2025 Paper I: Q101 “► Official Answer: Question Dropped (X)” — no answer, kept as printed, not in option D", !p25a[100].printedAnswer.length && /Question Dropped/.test(p25a[100].printedAnswerRaw ?? "") && p25a[100].options[3].text === "II and IV", p25a[100]);

  section("Synthetic edge cases of the same formats");
  const q = (text: string) => blockToQuestion({ section: "", number: 1, label: "1", lines: [], text }, 1, "DOCX").q;
  let r = q("Which nerve?\n(a) Glossopharyngeal\n(b) Vagus ✓\n(c) Spinal accessory\n(d) Hypoglossal");
  check("bare ✓ after an option → that option's printed answer, mark removed", r.printedAnswer.join() === "B" && r.options[1].text === "Vagus" && r.options.length === 4, r);
  r = q("Value?\n(a) 2√\n(b) 3\n(c) 4\n(d) 5");
  check("a lone √ at the end of an option is mathematics, not a mark", !r.printedAnswer.length && r.options[0].text === "2√", r);
  r = q("Organelle?\n(a) Nucleus\n(b) Ribosome\n(c) Golgi\n(d) Lysosome (Correct Answer)");
  check("“(Correct Answer)” after an option → printed answer", r.printedAnswer.join() === "D" && r.options[3].text === "Lysosome", r);
  r = q("X?\n(a) one ✓ Correct Answer\n(b) two\n(c) three ✓\n(d) four");
  check("two marked options → both kept with a note (never one chosen)", r.printedAnswer.join() === "A,C" && (r.notes ?? []).some((n) => /more than one option is marked/.test(n)), r);
  r = q("Deficiency of\n(a) zinc\n(b) cobalt\n(c) selenium ✓ Correct Answer\n(d) chromium");
  check("“✓ Correct Answer” never reads the NEXT line's label (2013 bug)", r.printedAnswer.join() === "C" && r.options[3].text === "chromium");
  r = q("Vibration white finger refers to:\n(a) Buerger's disease\n(b) Raynaud's syndrome\n(c) Acrocyanosis\n(d) Takayasu disease\n✓ Correct Answer: (b) Raynaud's syndrome");
  check("answer line after the options (2025 Paper II) still read", r.printedAnswer.join() === "B" && r.options[3].text === "Takayasu disease");
  r = q("Which are correct?\nI. a\nII. b\n(a) I only\n(b) II only\n(c) Both\n(d) Neither\n► Official Answer: Option (c) — Both");
  check("“► Official Answer: Option (c) — text” still read", r.printedAnswer.join() === "C" && r.options[3].text === "Neither");
  const t = takePrintedAnswer("Q?\n(a) A\n(b) B\n(c) C\n(d) D\nAns: B");
  check("“Ans: B” on its own line still read", t.answer.join() === "B");
  const split = (text: string) => splitQuestions(text.split("\n").map((x) => ({ text: x }))).blocks.map((b) => `${b.section}${b.number}`).join(",");
  const four = "(a) p\n(b) q\n(c) r\n(d) s";
  check("statement list without a lead-in word stays in its question (no false restart)", split(`${Array.from({ length: 13 }, (_, i) => `${i + 1}. Q${i + 1}?\n${four}`).join("\n")}\n14. The abnormality is\n1. Granular casts\n2. Red cell casts\n${four}\n15. Next?\n${four}`) === Array.from({ length: 15 }, (_, i) => i + 1).join(","));
  check("List II entries after a List I A.–D. run stay in their question", split(`${Array.from({ length: 23 }, (_, i) => `${i + 1}. Q?\n${four}`).join("\n")}\n24. Match List I with List II\nList I\nA. x\nB. y\nC. z\nD. w\nList II (Microbe)\n1. Coxiella\n2. R. rickettsii\n3. R. typhi\n4. R. prowazekii\nCode :\n${four}\n25. Next?\n${four}`) === Array.from({ length: 25 }, (_, i) => i + 1).join(","));
  check("a real restart after complete options + a heading still opens section S2", split(`${Array.from({ length: 6 }, (_, i) => `${i + 1}. Q?\n${four}`).join("\n")}\nSECTION B\n1. New section?\n${four}`) === "1,2,3,4,5,6,S21");
  check("“more than one route of transmission” → single-correct", detectType("One of the following diseases has more than one route of transmission", 4, false) === "SINGLE_CORRECT");
  check("“more than one correct option” → multiple-correct", detectType("One or more than one correct option may apply", 4, false) === "MULTIPLE_CORRECT");
  check("cover-page instruction with no options → instruction, not a question", candidateInstruction({ stem: "This Test Booklet contains 120 items (questions). Mark the response on the Answer Sheet.", options: [{ label: "A", printed: "(a)", text: "If a candidate gestures to the invigilator …" }] }));
  check("a clinical question mentioning a candidate drug is still a question", !candidateInstruction({ stem: "A candidate gene for this disease is", options: [{ label: "A", printed: "(a)", text: "BRCA1" }, { label: "B", printed: "(b)", text: "TP53" }, { label: "C", printed: "(c)", text: "RB1" }, { label: "D", printed: "(d)", text: "APC" }] }));
  const f = (stem: string, options = ["1 and 2", "2 and 3", "1 and 3", "1, 2 and 3"]) => questionFormats({ stem, options: options.map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t })), type: "SINGLE_CORRECT", figures: [], listI: null, printedAnswer: [] });
  check("formats: statement-code", f("Consider the following statements:\n1. a\n2. b\n3. c\nWhich are correct?").includes("STATEMENT_CODE"));
  check("formats: Statement I / Statement II (assertion–reason style)", f("Statement I : x\nStatement II : y\nWhich one is correct?", ["Both", "Both, not", "I only", "II only"]).includes("ASSERTION_REASON"));
  check("formats: pairs", f("Consider the following pairs:\nHow many of the pairs given above are correctly matched?", ["One", "Two", "Three", "All four"]).includes("PAIRS"));
  check("formats: sequence", f("What is the correct order?", ["1 → 3 → 4 → 2", "4 → 2 → 3 → 1", "2 → 1 → 4 → 3", "1 → 3 → 2 → 4"]).includes("SEQUENCE"));
  check("formats: clinical case", f("A 52-year-old female complains of pain in the right shoulder.", ["a", "b", "c", "d"]).includes("CLINICAL_CASE"));
  check("formats: negative stem (EXCEPT)", f("All of the following are true EXCEPT", ["a", "b", "c", "d"]).includes("NEGATIVE_STEM"));
  check("formats: malformed options", f("Q?", ["a", "b", ""]).includes("OPTIONS_MALFORMED"));

  section("Answer keys — layouts, dropped items, completeness");
  const kp = parseKeyText("Q. No. Key\n1 C\n108 X\n5 ×\n48 A/B");
  check("text key: “X” / “×” read as a dropped item, “A/B” kept as printed", kp.find((x) => x.number === 108)?.raw === "X" && kp.find((x) => x.number === 5)?.raw === "×" && kp.find((x) => x.number === 48)?.raw === "A/B", kp);
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, section: "", raw: "A" }));
  check("AI key reading of 15 of 120 (2013 grid) → incomplete, not used", JSON.stringify(keyReadingIncomplete("ai", pairs(15), 120)) === JSON.stringify({ read: 15, expected: 120 }));
  check(`AI key reading of ${Math.ceil(120 * KEY_MIN_COVERAGE)} of 120 → used`, keyReadingIncomplete("ai", pairs(Math.ceil(120 * KEY_MIN_COVERAGE)), 120) === null);
  check("text-layer key is never refused for coverage; unknown size is never refused", keyReadingIncomplete("local", pairs(15), 120) === null && keyReadingIncomplete("ai", pairs(15), null) === null);
  for (const id of ["cms-2013-p1", "cms-2013-p2", "cms-2024-p1", "cms-2024-p2"]) {
    const k = truth.papers[id].officialKey!;
    check(`${id}: official key fixture has 120 entries`, Object.keys(k).length === 120);
  }

  section("Scanned 2024 papers — number-sequence guard on the stored AI readings");
  for (const id of ["cms-2024-p1", "cms-2024-p2"]) {
    const p = truth.papers[id];
    const reads = p.storedReads!.map((x, i) => ({ ...x, id: `${id}#${i}` }));
    // Instructions to candidates are excluded from key matching (and no longer saved as questions).
    const notInstruction = reads.filter((x) => !(x.page === 1 || (x.options <= 1 && x.sourceNumber === null)));
    const guarded = numberSequenceProblems(notInstruction.filter((x) => /^AI/.test(x.method)).map((x) => ({ id: x.id, page: x.page, section: "", number: x.number })));
    const key = p.officialKey!;
    const wrongBefore = reads.filter((x) => x.number !== null && x.sourceNumber !== x.number && key[String(x.number)]);
    const wrongAfter = notInstruction.filter((x) => x.number !== null && !guarded.has(x.id) && x.sourceNumber !== x.number && key[String(x.number)]);
    const residual = id === "cms-2024-p1" ? [] : ["10:44", "10:45"];
    console.log(`  info  ${id}: ${wrongBefore.length} stored question(s) took another question's key entry before; guarded pages ${[...new Set(notInstruction.filter((x) => guarded.has(x.id)).map((x) => x.page))].join(",")}`);
    check(`${id}: after the guard, the only number matches with the wrong text are the documented in-sequence shift (${residual.join(", ") || "none"})`, wrongAfter.map((x) => `${x.page}:${x.number}`).join() === residual.join(), wrongAfter);
    check(`${id}: every misnumbered page found by its sequence is guarded`, reads.filter((x) => x.number !== null && x.sourceNumber !== null && x.sourceNumber !== x.number && !residual.includes(`${x.page}:${x.number}`)).every((x) => guarded.has(x.id)));
  }
  const seqOf = (nums: (number | null)[]) => numberSequenceProblems(nums.map((n, i) => ({ id: String(i), page: 2, section: "", number: n }))).size;
  check("a gap filled by a question read without a number is explained (5, 6, 7, —, 9, 10)", seqOf([5, 6, 7, null, 9, 10]) === 0);
  check("an unexplained gap (5, 6, 9) or a reversal (24, 23) is guarded", seqOf([5, 6, 9]) === 3 && seqOf([24, 23, 25]) === 3);
  const cover = truth.papers["cms-2024-p1"].storedReads!.filter((x) => x.page === 1);
  check("2024 Paper I: the 4 cover-page items are not source questions (truth)", cover.length === 4 && cover.every((x) => x.sourceNumber === null));
  check("2024 Paper I: the real Q1–Q4 were stored without numbers because the cover items took 1–4 (truth)", truth.papers["cms-2024-p1"].storedReads!.filter((x) => x.page === 2 && x.number === null).map((x) => x.sourceNumber).join() === "1,2,3,4");

  section("Paper-format memory — evidence only, paper vs exam scope, never answers");
  const at = "2026-10-31T00:00:00.000Z";
  const base = (id: string, qs: (ExtractedQuestion & { heading: string | null })[], extra: Partial<LearnInput> = {}): LearnInput => ({ jobId: `job-${id}`, jobTitle: id, paper: truth.papers[id].paper, fileName: truth.papers[id].file, fileSha256: truth.papers[id].sha256, at, source: { questions: qs, numberStyles: qs.map(() => (id.startsWith("cms-2025") ? "QN." : "N.")), sectionRestarts: 0 }, approvedKey: null, approvedSubjects: null, ocrCorrections: [], ...extra });
  check("paperOf: “UPSC CMS PAPER 2” → PAPER II, “cms 2025 1” → null", paperOf("UPSC CMS PAPER 2") === "PAPER II" && paperOf("UPSC CMS PAPER 1") === "PAPER I" && paperOf("cms 2025 1") === null);
  if (p25b && p13a && p13b) {
    const r25 = learnPaperRules(base("cms-2025-p2", p25b));
    const heads = r25.find((x) => x.kind === "SECTION_HEADINGS");
    check("2025 Paper II: headings learned as a PAPER II rule with full support", heads?.scope === "PAPER" && heads.paper === "PAPER II" && (heads.value.headings as string[]).length === 3 && heads.evidence.supporting === 120, heads);
    check("2025 Paper II: answer printed on a line after the options, prefix “✓ Correct Answer:”", r25.find((x) => x.kind === "ANSWER_MARK")?.key === "ANSWER_MARK:answer line after the options (“✓ Correct Answer:”)", r25.find((x) => x.kind === "ANSWER_MARK")?.key);
    check("2013 Paper I: no SECTION_HEADINGS rule other than “none”", learnPaperRules(base("cms-2013-p1", p13a)).find((x) => x.kind === "SECTION_HEADINGS")?.key === "SECTION_HEADINGS:none");
    const r13 = learnPaperRules(base("cms-2013-p1", p13a));
    check("2013 Paper I: answer printed as a mark after the option text", r13.find((x) => x.kind === "ANSWER_MARK")?.key.includes("mark after the option text") === true, r13.find((x) => x.kind === "ANSWER_MARK"));
    check("no official-key rule without an admin-approved complete key (AI readings are not evidence)", !r13.some((x) => x.kind === "ANNOTATION_RELIABILITY" || x.kind === "ANSWER_KEY_LAYOUT"));
    check("no rule stores an answer", ![...r25, ...r13].some((x) => /"(?:answer|finalAnswer|official)"/i.test(JSON.stringify(x.value))));
    const keyMap = new Map(Object.entries(truth.papers["cms-2013-p1"].officialKey!).map(([n, v]) => [Number(n), v] as const));
    const withKey = learnPaperRules(base("cms-2013-p1", p13a, { approvedKey: { fileName: "key.pdf", fileSha256: "daf9", values: keyMap, expected: 120, fileKind: "pdf", read: "AI vision" } }));
    const rel = withKey.find((x) => x.kind === "ANNOTATION_RELIABILITY");
    check("with an approved key: mark reliability measured (103 of 119 agree, 16 contradict)", rel?.value.agree === 103 && rel?.value.total === 119 && (rel?.value.disagree as number[]).length === 16, rel?.value);
    check("with an approved key: dropped marker “X” learned", withKey.find((x) => x.kind === "DROPPED_MARKER")?.value.marker === "X");
    let n = 0;
    const id = () => `r${++n}`;
    let m = mergePaperRules([], [...r13, ...learnPaperRules(base("cms-2013-p2", p13b))], at, id);
    const count = m.rules.length;
    m = mergePaperRules(m.rules, r13, at, id);
    check("learning the same paper again adds nothing (evidence replaced, not doubled)", m.rules.length === count && m.added === 0 && m.rules.every((x) => x.evidence.length <= 2), { before: count, after: m.rules.length, added: m.added });
    const exam = m.rules.find((x) => x.scope === "EXAM" && x.kind === "OPTION_LABELS");
    check("a fact seen in PAPER I and PAPER II becomes an EXAM proposal (option labels “(a)”)", !!exam && exam.status === "PROPOSED" && exam.evidence.length === 2, exam);
    check("paper rules stay per paper (headings of PAPER I ≠ PAPER II)", m.rules.filter((x) => x.kind === "SECTION_HEADINGS" && x.scope === "PAPER").length === 2);
    const numbering = m.rules.find((x) => x.kind === "NUMBERING" && x.paper === "PAPER I")!;
    numbering.status = "CONFIRMED";
    const other = mergePaperRules(m.rules, [{ ...r13.find((x) => x.kind === "NUMBERING")!, key: "NUMBERING:QN.|restarts:0", statement: "other" }], at, id);
    const after = other.rules.find((x) => x.id === numbering.id)!;
    check("new evidence with a different value contradicts a confirmed rule → back to review", after.status === "PROPOSED" && after.contradictedBy === "NUMBERING:QN.|restarts:0" && other.contradicted >= 1, after);
    const scopeRule: PaperRule = { ...m.rules[0], id: "s", kind: "SUBJECT_SCOPE", scope: "PAPER", paper: "PAPER II", key: "SUBJECT_SCOPE:x", value: { subjects: { "General Surgery": 40, "Obstetrics & Gynaecology": 40 } }, status: "PROPOSED", contradictedBy: null };
    check("a proposed subject scope is not used", confirmedSubjectScope([scopeRule], "PAPER II") === null);
    check("a confirmed subject scope is used for its paper only", confirmedSubjectScope([{ ...scopeRule, status: "CONFIRMED" }], "PAPER II")?.has("General Surgery") === true && confirmedSubjectScope([{ ...scopeRule, status: "CONFIRMED" }], "PAPER I") === null);
    check("generalize is stable (running it again adds no rule)", generalize(m.rules, at, id).length === m.rules.length);
  }
  check("OCR pair from an admin correction: “Gluococortids” → “Glucocorticoids”", JSON.stringify(ocrPairs("(c) Gluococortids", "(c) Glucocorticoids")) === JSON.stringify([{ wrong: "Gluococortids", right: "Glucocorticoids" }]));
  check("a rewrite is not an OCR confusion", ocrPairs("Assertion (A): x", "Statement I : x and more words").length === 0);

  section("Verification state — fingerprints, invalidation, never verified by extraction alone");
  const e: ExtractedQuestion = { section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "Deficiency of", options: ["zinc", "cobalt", "selenium", "chromium"].map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t })), printedAnswer: ["C"], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "DOCX", notes: [] };
  const fp = (x: ExtractedQuestion, s: string | null = "s1", a = ["C"]) => fingerprintsOf({ e: x, finalAnswer: a, subjectId: s, topicId: null, subTopicId: null, figures: [] });
  check("a freshly extracted question has no verification (Verify 1 / 2: none) — extraction is never verification", verifyState(e, fp(e)).v1 === "none" && verifyState(e, fp(e)).v2 === "none");
  const verified = { ...e, paperVerify: { v1: { fingerprint: fp(e).legacy, parts: fp(e).parts, at, passed: true, problems: [], fixes: [] }, v2: { fingerprint: fp(e).legacy, parts: fp(e).parts, at, status: "VERIFIED" } } } as unknown as ExtractedQuestion;
  check("verified before a change", verifyState(verified, fp(e)).v1 === "passed" && verifyState(verified, fp(e)).v2 === "verified");
  const edited = { ...e, options: e.options.map((o, i) => (i === 3 ? { ...o, text: "chromium oxide" } : o)) };
  check("an option text change makes both results out of date", verifyState(verified, fp(edited)).v1 === "stale" && verifyState(verified, fp(edited)).v2 === "stale");
  check("a changed answer makes both results out of date", verifyState(verified, fp(e, "s1", ["D"])).v2 === "stale");
  check("a changed number makes both results out of date (misnumbered questions re-verify)", verifyState(verified, fp({ ...e, number: 9 })).v1 === "stale");
  check("a subject / topic change leaves content verification current (taxonomy checked separately)", verifyState(verified, fp(e, "s2")).v2 === "verified" && fp(e, "s2").parts.taxonomy !== fp(e).parts.taxonomy);
  check("removing a lone printed tick (annotation) does not change the content fingerprint", fp({ ...e, options: e.options.map((o, i) => (i === 3 ? { ...o, text: "chromium\n✓" } : o)) }).parts.content === fp(e).parts.content);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
