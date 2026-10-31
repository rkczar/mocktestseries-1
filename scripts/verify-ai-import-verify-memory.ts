/**
 * Paper Intelligence Memory in AI verification (feat/verify-paper-memory) — suite on the ORIGINAL CMS papers and a
 * disposable scratch database (no AI, no network, Question Bank never touched):
 *
 *   A. Pure: the memory text an AI request gets (confirmed only, this paper only, the kinds that request uses, bounded),
 *      the deterministic memory checks on the known CMS failures — 2013 Word "with Answers" (false section restart, lost
 *      options, printed ticks that contradict the official key), 2024 scanned (cover instructions read as Q1–4, real
 *      Q1–4 without numbers), 2025 (subject scope; and NO false finding on the clean 2025 / corrected 2013 papers) —
 *      learning from confirmed corrections, field-level checks, prompt builders.
 *   B. Database: an admin correction teaches nothing until the question is approved; approval / rejection proposes
 *      rules (PROPOSED, with evidence); unconfirmed rules are never used; confirmed rules flag a NEW upload of the same
 *      paper (post-processing) and Verify 1 field by field, never another paper; a Verify 2 suggestion is applied only
 *      by the administrator, recorded, and then learnable; nothing changes approved questions or answers.
 *
 *   AI_IMPORT_PAPER_FIXTURES=<originals> DATABASE_URL=<scratch> AI_IMPORT_VAULT_DIR=<scratch> STORAGE_DIR=<scratch> \
 *   IMPORT_STAGING_DIR=<scratch> AI_IMPORT_DISABLE_KICK=1 NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/verify-ai-import-verify-memory.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { putContent } from "@/lib/ai-import/vault";
import { readDocx } from "@/lib/ai-import/docx";
import { docxQuestions } from "@/lib/ai-import/process";
import { runPostProcessing } from "@/lib/ai-import/post";
import { runVerify1 } from "@/lib/ai-import/paper-verify";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { learnFromCorrections } from "@/lib/ai-import/paper-learn";
import { applyVerifySuggestion, approveQuestions, editQuestion, rejectQuestions } from "@/lib/ai-import/review";
import { decidePaperRule, examPaperRules, jobMemoryBrief } from "@/lib/ai-import/taxonomy-memory";
import { MEMORY_BRIEF_MAX, confirmedRulesFor, correctionProposals, detectPattern, learnPaperRules, memoryBrief, memoryFindings, mergePaperRules, type CorrectionItem, type PaperRule } from "@/lib/ai-import/paper-memory";
import { fieldBoard, v1FieldChecks, v2FieldChecks, type AnswerFacts } from "@/lib/ai-import/field-checks";
import { documentTextUserText, extractUserText, keyUserText } from "@/lib/ai-import/prompts";
import { classifyUserText } from "@/lib/ai-import/taxonomy-check";
import { fingerprintsOf, stampOf } from "@/lib/ai-import/verify-core";
import { sourceKeyOf, type ExtractedQuestion } from "@/lib/ai-import/types";

if (!/mts_paperintel|_scratch|paperverify/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be a disposable scratch database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.AI_IMPORT_PAPER_FIXTURES) {
  console.error("Set AI_IMPORT_VAULT_DIR (scratch) and AI_IMPORT_PAPER_FIXTURES (the original papers).");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ""}`);
}
async function refused(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e instanceof Error ? e.message : String(e));
  }
}

type Truth = { file: string; sha256?: string; officialKey?: Record<string, string>; sourceMarkContradictsKey?: number[]; index?: Record<string, { page: number; opening: string }>; storedReads?: { page: number; number: number | null; options: number; method: string; sourceNumber: number | null }[] };
const truth = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/truth.json", "utf8")).papers as Record<string, Truth>;
const FX = process.env.AI_IMPORT_PAPER_FIXTURES!;
const RUN = Date.now().toString(36);
const NOW = new Date().toISOString();
let idn = 0;
const newId = () => `r${++idn}`;
const confirmAll = (rules: PaperRule[]) => rules.map((r) => ({ ...r, status: "CONFIRMED" as const }));
const learn = (rules: PaperRule[], proposals: Parameters<typeof mergePaperRules>[1]) => mergePaperRules(rules, proposals, NOW, newId).rules;
const ctx = (over: Partial<Parameters<typeof memoryFindings>[3]> = {}): Parameters<typeof memoryFindings>[3] => ({ aiRead: false, officialAnswer: true, finalAnswer: [], subjectName: null, fileSha256: null, ...over });
const INSTRUCTION = "This Test Booklet contains 120 items (questions). Each item comprises four responses. Mark your response on the Answer Sheet only.";
const mk = (n: number | null, stem: string, options = 4, extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion => ({ section: "", number: n, label: String(n ?? "?"), pages: [1], type: "SINGLE_CORRECT", stem, options: Array.from({ length: options }, (_, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: `option ${"abcd"[i]} of ${stem.slice(0, 12)}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "AI_VISION", notes: [], ...extra });

async function main() {
  // =================================================================================================================
  section("A1. Memory text for AI requests — confirmed only, this paper only, the kinds each request uses, bounded");
  const p13 = docxQuestions(await readDocx(path.join(FX, truth["cms-2013-p1"].file)));
  const key13 = truth["cms-2013-p1"].officialKey!;
  const lines13 = (await readDocx(path.join(FX, truth["cms-2013-p1"].file))).lines.map((l) => l.text);
  const styles13 = p13.map((q) => (lines13.some((l) => new RegExp(`^\\s*Q\\.?\\s*${q.number}\\s*\\.`).test(l)) ? "QN." : "N."));
  const rules13 = learn([], learnPaperRules({ jobId: "j13", jobTitle: "CMSE 2013 Paper I", paper: "PAPER I", fileName: truth["cms-2013-p1"].file, fileSha256: truth["cms-2013-p1"].sha256 ?? "sha13", at: NOW, source: { questions: p13, numberStyles: styles13, sectionRestarts: new Set(p13.map((q) => q.section)).size - 1 }, approvedKey: { fileName: "paper-1-answer-key.pdf", fileSha256: "shakey13", values: new Map(Object.entries(key13).map(([n, v]) => [Number(n), v])), expected: 120, fileKind: "pdf", read: "AI vision" }, approvedSubjects: null, ocrCorrections: [] }));
  check("2013 Paper I (current reader) learned: one numbering sequence of 120, four options, printed marks vs official key", rules13.some((r) => r.kind === "NUMBERING" && r.value.sectionRestarts === 0 && r.value.questions === 120) && rules13.some((r) => r.kind === "OPTION_LABELS") && rules13.some((r) => r.kind === "ANNOTATION_RELIABILITY" && Number(r.value.agree) < Number(r.value.total)), rules13.map((r) => [r.kind, r.value]));
  const rel = rules13.find((r) => r.kind === "ANNOTATION_RELIABILITY")!;
  check("the 2013 Paper I Word ticks contradict the official key in 16 questions (as audited)", Number(rel.value.total) - Number(rel.value.agree) === truth["cms-2013-p1"].sourceMarkContradictsKey!.length, rel.value);
  check("PROPOSED rules give NO memory text (nothing unconfirmed reaches an AI request)", memoryBrief(rules13, "PAPER I", "extract") === "" && memoryBrief(rules13, "PAPER I", "key") === "");
  const c13 = confirmAll(rules13);
  const brief = memoryBrief(c13, "PAPER I", "extract");
  check("confirmed: the extraction / Verify text names numbering, option labels and the printed-mark reliability", /PAPER MEMORY/.test(brief) && /numbered/.test(brief) && /labelled/.test(brief) && /official key/.test(brief), brief);
  check("…marked as DATA, never a source of text / options / answers", /not instructions/.test(brief) && /Never use it to supply text, options, numbers or answers/.test(brief));
  check("PAPER I rules are not sent for PAPER II (another paper)", memoryBrief(c13, "PAPER II", "extract") === "" && memoryBrief(c13, null, "extract") === "");
  check("the key request gets key facts only (no option / mark rules); classification gets no numbering / option rules", !/labelled|printed answer marks/i.test(memoryBrief(c13, "PAPER I", "key")) && /official key is/i.test(memoryBrief(c13, "PAPER I", "key")) && !/numbered|labelled/.test(memoryBrief(c13, "PAPER I", "classify")), [memoryBrief(c13, "PAPER I", "key"), memoryBrief(c13, "PAPER I", "classify")]);
  const contradicted = c13.map((r) => (r.kind === "OPTION_LABELS" ? { ...r, contradictedBy: "OPTION_LABELS:x" } : r));
  check("a contradicted rule is left out", !/labelled/.test(memoryBrief(contradicted, "PAPER I", "extract")));
  const many: PaperRule[] = Array.from({ length: 60 }, (_, i) => ({ ...c13[0], id: `m${i}`, kind: "OCR_CONFUSION", key: `OCR_CONFUSION:w${i}`, statement: `OCR reads “word${i}” as “w0rd${i}” — reported where it occurs, never replaced automatically.`.repeat(2), value: { wrong: `w0rd${i}`, right: `word${i}` } }));
  check(`the memory text never exceeds ${MEMORY_BRIEF_MAX} characters`, memoryBrief(many, "PAPER I", "extract").length <= MEMORY_BRIEF_MAX && memoryBrief(many, "PAPER I", "extract").length > 500);
  check("no rule in memory holds an answer", c13.every((r) => !/"(?:answer|finalAnswer|officialAnswer)"/.test(JSON.stringify(r.value))));

  // =================================================================================================================
  section("A2. CMS 2013 Paper I — the production failure (release 85dac10 reader) found by confirmed memory");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "old-reader-"));
  writeFileSync(path.join(tmp, "local-parse.ts"), execFileSync("git", ["show", "85dac10:lib/ai-import/local-parse.ts"]));
  const old = (await import(pathToFileURL(path.join(tmp, "local-parse.ts")).href)) as typeof import("@/lib/ai-import/local-parse");
  const doc13 = await readDocx(path.join(FX, truth["cms-2013-p1"].file));
  const oldQs = old.splitQuestions(doc13.lines).blocks.map((b) => old.blockToQuestion(b, 1, "DOCX").q);
  const f = (q: ExtractedQuestion, c = ctx()) => memoryFindings(c13, "PAPER I", q, c);
  const falseRestart = oldQs.filter((q) => q.section === "S2");
  check("the 4 questions of the false section “S2” are flagged on the NUMBER field (one sequence 1–120 confirmed)", falseRestart.length === 4 && falseRestart.every((q) => f(q).some((x) => x.field === "number" && /numbering restart/.test(x.detail))), falseRestart.map((q) => f(q)));
  const lost = oldQs.filter((q) => q.options.length !== 4);
  check("questions whose options were lost are flagged on the OPTIONS field", lost.length > 0 && lost.every((q) => f(q).some((x) => x.field === "options")), [lost.length, lost.map((q) => [q.number, q.options.length])]);
  const fromTick = p13.filter((q) => q.printedAnswer.length);
  check("an answer taken only from a printed tick (no official key matched) is flagged on the ANSWER field", fromTick.length > 100 && fromTick.every((q) => f(q, ctx({ officialAnswer: false, finalAnswer: q.printedAnswer })).some((x) => x.field === "answer" && /contradicted the official key in 16 of/.test(x.detail))), fromTick.length);
  check("…but not when the answer comes from the official key", fromTick.every((q) => !f(q, ctx({ officialAnswer: true, finalAnswer: q.printedAnswer })).some((x) => x.field === "answer")));
  const clean13 = p13.flatMap((q) => f(q, ctx({ officialAnswer: true })));
  check("no false finding on the correctly read 2013 Paper I (120 questions, official answers)", clean13.length === 0 && p13.length === 120, clean13.slice(0, 5));

  // =================================================================================================================
  section("A3. CMS 2024 Paper I (scanned) — cover instructions as Q1–4, real Q1–4 without numbers: learned, then caught");
  const t24 = truth["cms-2024-p1"];
  const reads24: ExtractedQuestion[] = t24.storedReads!.slice(0, 12).map((r) => (r.options === 1 ? mk(r.number, INSTRUCTION, 1) : mk(r.number, t24.index![String(r.sourceNumber ?? r.number)]?.opening ?? "question", 4)));
  const instr = reads24.filter((q) => q.options.length === 1);
  const unnumbered = reads24.filter((q) => q.number === null);
  check("reconstructed production reads: 4 instruction items as Q1–4, 4 real questions without a number", instr.length === 4 && unnumbered.length === 4, reads24.map((q) => [q.number, q.options.length]));
  const items24: CorrectionItem[] = [
    ...instr.map((q): CorrectionItem => ({ fileId: "f24", label: String(q.number), kind: "REJECT", before: q, after: null, aiRead: true, acceptedSuggestion: false })),
    ...unnumbered.map((q, i): CorrectionItem => ({ fileId: "f24", label: `p2-${i + 1}`, kind: "EDIT", before: q, after: { ...q, number: i + 1, label: String(i + 1) }, aiRead: true, acceptedSuggestion: i === 0 })),
  ];
  const prop24 = correctionProposals({ jobId: "j24", jobTitle: "CMS 2024 Paper I", paper: "PAPER I", at: NOW, files: new Map([["f24", { name: t24.file, sha: t24.sha256 ?? "sha24" }]]), items: items24 });
  const byPat = (p: string) => prop24.find((x) => x.kind === "EXTRACTION_ERROR" && x.value.pattern === p);
  check("approved corrections propose INSTRUCTION_AS_QUESTION (4 rejections) and NUMBER_MISSING (4 numbers set)", byPat("INSTRUCTION_AS_QUESTION")?.evidence.supporting === 4 && byPat("NUMBER_MISSING")?.evidence.supporting === 4, prop24.map((x) => [x.key, x.evidence.detail]));
  check("evidence: source paper + file + SHA-256, ADMIN_CONFIRMED, the questions, an accepted suggestion counted", byPat("NUMBER_MISSING")!.evidence.fileName === t24.file && !!byPat("NUMBER_MISSING")!.evidence.fileSha256 && byPat("NUMBER_MISSING")!.evidence.source === "ADMIN_CONFIRMED" && /1 from an accepted Verify suggestion/.test(byPat("NUMBER_MISSING")!.evidence.detail), byPat("NUMBER_MISSING")!.evidence);
  check("scope: PAPER I only (an exam rule needs a second paper)", prop24.every((x) => x.scope === "PAPER" && x.paper === "PAPER I"));
  let rules24 = learn([], prop24);
  check("stored as PROPOSED, with confidence and approval status", rules24.every((r) => r.status === "PROPOSED" && r.confidence === 1 && r.decidedById === null));
  check("PROPOSED → no finding on a new upload with the same failure", reads24.every((q) => memoryFindings(rules24, "PAPER I", q, ctx({ aiRead: true })).length === 0));
  rules24 = confirmAll(rules24);
  const again = reads24.map((q) => memoryFindings(rules24, "PAPER I", q, ctx({ aiRead: true })));
  check("CONFIRMED → a new upload's cover instructions are flagged (text field: instruction read as a question)", instr.every((q) => memoryFindings(rules24, "PAPER I", q, ctx({ aiRead: true })).some((x) => x.field === "text" && /instruction to candidates/.test(x.detail))));
  check("CONFIRMED → questions read without their number are flagged (number field)", unnumbered.every((q) => memoryFindings(rules24, "PAPER I", q, ctx({ aiRead: true })).some((x) => x.field === "number")));
  check("correctly read questions of the same page set are not flagged", reads24.filter((q) => q.number !== null && q.options.length === 4).every((q) => memoryFindings(rules24, "PAPER I", q, ctx({ aiRead: true })).length === 0), again);
  check("a PAPER I rule never flags a PAPER II upload", reads24.every((q) => memoryFindings(rules24, "PAPER II", q, ctx({ aiRead: true })).length === 0));
  const twoPapers = learn(learn([], prop24), prop24.map((x) => ({ ...x, paper: "PAPER II", evidence: { ...x.evidence, jobId: "j24b" } })));
  check("the same correction confirmed in PAPER I and PAPER II → an EXAM-wide proposal (still PROPOSED)", twoPapers.some((r) => r.scope === "EXAM" && r.kind === "EXTRACTION_ERROR" && r.status === "PROPOSED"));

  // =================================================================================================================
  section("A4. CMS 2025 Paper II — subject scope, and no false finding on a clean paper");
  const p25 = docxQuestions(await readDocx(path.join(FX, "cms_2025_2_.docx")));
  const subj25 = (n: number) => (n <= 40 ? "General Surgery" : n <= 80 ? "Obstetrics & Gynaecology" : "Community Medicine / PSM");
  const lines25 = (await readDocx(path.join(FX, "cms_2025_2_.docx"))).lines.map((l) => l.text);
  const rules25 = confirmAll(learn([], learnPaperRules({ jobId: "j25", jobTitle: "cms 2025 2", paper: "PAPER II", fileName: "cms_2025_2_.docx", fileSha256: "sha25", at: NOW, source: { questions: p25.map((q) => ({ ...q, heading: q.hints?.subject ?? null })), numberStyles: p25.map((q) => (lines25.some((l) => new RegExp(`^\\s*Q${q.number}\\.`).test(l)) ? "QN." : "N.")), sectionRestarts: 0 }, approvedKey: { fileName: "key25.jpg", fileSha256: "k25", values: new Map(p25.map((q) => [q.number!, q.printedAnswer[0]])), expected: 120, fileKind: "image", read: "AI vision" }, approvedSubjects: new Map([["General Surgery", 40], ["Obstetrics & Gynaecology", 40], ["Community Medicine / PSM", 40]]), ocrCorrections: [] })));
  const f25 = p25.flatMap((q) => memoryFindings(rules25, "PAPER II", q, ctx({ officialAnswer: true, finalAnswer: q.printedAnswer, subjectName: subj25(q.number!) })));
  check("2025 Paper II (120 clean questions, approved subjects, official answers): no memory finding", p25.length === 120 && f25.length === 0, f25.slice(0, 4));
  const outside = memoryFindings(rules25, "PAPER II", p25[96], ctx({ subjectName: "Pediatrics" }));
  check("a subject outside the confirmed Paper II scope is flagged on the SUBJECT field (never changed)", outside.some((x) => x.field === "subject" && /covers/.test(x.detail)), outside);
  check("the classification request of Paper II gets its confirmed subject scope", /General Surgery/.test(memoryBrief(rules25, "PAPER II", "classify")) && memoryBrief(rules25, "PAPER I", "classify") === "");

  // =================================================================================================================
  section("A5. OCR confusions and printed-mark errors learned from approved corrections");
  const ocrBefore = mk(7, "A patient with acute rnyocardial infarction presents with chest pain");
  const ocrItems: CorrectionItem[] = [{ fileId: "f", label: "7", kind: "EDIT", before: ocrBefore, after: { ...ocrBefore, stem: ocrBefore.stem.replace("rnyocardial", "myocardial") }, aiRead: true, acceptedSuggestion: false }];
  const ocrRules = confirmAll(learn([], correctionProposals({ jobId: "jo", jobTitle: "t", paper: "PAPER I", at: NOW, files: new Map([["f", { name: "scan.pdf", sha: "s" }]]), items: ocrItems })));
  check("an AI-read word an administrator corrected is proposed as an OCR confusion", ocrRules.some((r) => r.kind === "OCR_CONFUSION" && r.value.wrong === "rnyocardial" && r.value.right === "myocardial"));
  const next = mk(9, "ECG changes of rnyocardial ischaemia");
  check("confirmed: flagged where it recurs in AI-read text (with the corrected word as suggestion)", memoryFindings(ocrRules, "PAPER I", next, ctx({ aiRead: true })).some((x) => x.field === "text" && /myocardial/.test(x.detail)));
  check("…never in a document read exactly (Word / text layer)", memoryFindings(ocrRules, "PAPER I", next, ctx({ aiRead: false })).length === 0);
  check("…and a word that only contains it is not matched", memoryFindings(ocrRules, "PAPER I", mk(9, "xrnyocardialx"), ctx({ aiRead: true })).length === 0);
  const tickBefore = { ...p13[0], options: p13[0].options.map((o, i) => (i === 1 ? { ...o, text: `${o.text}\n✓` } : o)) };
  check("a printed tick left at the end of an option is detected (ANSWER_MARK_IN_TEXT, option B)", detectPattern("ANSWER_MARK_IN_TEXT", tickBefore)?.field === "option B");
  const tickProps = correctionProposals({ jobId: "jt", jobTitle: "t", paper: "PAPER I", at: NOW, files: new Map([["f", { name: "p.docx", sha: "s" }]]), items: [{ fileId: "f", label: "1", kind: "EDIT", before: tickBefore, after: p13[0], aiRead: false, acceptedSuggestion: false }] });
  check("…and its correction proposes that extraction error (no OCR rule from a Word source)", tickProps.some((x) => x.value.pattern === "ANSWER_MARK_IN_TEXT") && !tickProps.some((x) => x.kind === "OCR_CONFUSION"), tickProps.map((x) => x.key));
  check("an edit that did NOT remove the pattern teaches nothing", correctionProposals({ jobId: "jt", jobTitle: "t", paper: "PAPER I", at: NOW, files: new Map(), items: [{ fileId: "f", label: "1", kind: "EDIT", before: tickBefore, after: tickBefore, aiRead: false, acceptedSuggestion: false }] }).length === 0);

  // =================================================================================================================
  section("A6. Field-level checks");
  const ans = (over: Partial<AnswerFacts> = {}): AnswerFacts => ({ final: ["B"], official: ["B"], status: "OFFICIAL_MATCHED", adminConfirmed: false, ...over });
  const q = mk(5, "Which drug is used in the treatment of acute gout?");
  const name = (id: string | null | undefined) => (id ? `name:${id}` : null);
  const v1a = v1FieldChecks({ e: q, problems: [{ code: "ANSWER_IN_OPTION", detail: "Option C contains the printed answer “Ans: b” — remove it" }], fixes: [], issueCodes: [], issueLabel: (c) => c, memory: [{ field: "number", detail: "Paper memory (PAPER I, confirmed): …restart", ruleId: "r1" }], answer: ans(), classification: { status: "AGREED", stored: { subjectId: "s", topicId: "t", subTopicId: null }, found: { subjectId: "s", topicId: "t", subTopicId: null }, confidence: 0.9, method: "local", findings: ["s › t"] }, name, documentText: true });
  const at = (list: ReturnType<typeof v1FieldChecks>, fld: string) => list.find((x) => x.field === fld);
  check("Verify 1: an answer inside option C is a problem of OPTION C (not the whole question)", at(v1a, "option C")?.status === "PROBLEM" && at(v1a, "option A")?.status === "OK", v1a);
  check("Verify 1: a confirmed-memory finding is its own field problem, marked as paper memory", at(v1a, "number")?.status === "PROBLEM" && at(v1a, "number")?.by === "MEMORY");
  check("Verify 1: answer matching the official key → OK with that evidence; subject / topic agreed → OK", at(v1a, "answer")?.status === "OK" && /official answer key/.test(at(v1a, "answer")?.evidence ?? "") && at(v1a, "subject")?.status === "OK" && at(v1a, "topic")?.status === "OK");
  const v1b = v1FieldChecks({ e: { ...q, printedAnswer: ["B"] }, problems: [], fixes: [], issueCodes: [], issueLabel: (c) => c, memory: [], answer: ans({ official: [], status: "UNVERIFIED" }), classification: null, name, documentText: true });
  check("Verify 1: an answer from a printed mark without a key is NOT CHECKED (extraction is not verification)", at(v1b, "answer")?.status === "NOT_CHECKED" && /printed in the paper/.test(at(v1b, "answer")?.problem ?? ""), at(v1b, "answer"));
  const v1c = v1FieldChecks({ e: q, problems: [], fixes: [], issueCodes: [], issueLabel: (c) => c, memory: [], answer: ans({ final: ["C"], official: ["B"], status: "KEY_MISMATCH" }), classification: { status: "DISAGREEMENT", stored: { subjectId: "s1", topicId: null, subTopicId: null }, found: { subjectId: "s2", topicId: "t2", subTopicId: null }, confidence: 0.8, method: "local", findings: ["s1 vs s2"] }, name, documentText: true });
  check("Verify 1: an answer against the official key → problem, the key's value as suggestion (never applied)", at(v1c, "answer")?.status === "PROBLEM" && at(v1c, "answer")?.suggestion === "B", at(v1c, "answer"));
  check("Verify 1: a subject disagreement suggests the independent choice", at(v1c, "subject")?.status === "PROBLEM" && at(v1c, "subject")?.suggestion === "name:s2");
  const src = `5. Which drug is used in the treatment of acute gout?\n(a) Allopurinol (b) Colchicine (c) Probenecid (d) Febuxostat`;
  const stored = { ...q, options: [{ label: "A", printed: "(a)", text: "Allopurinol" }, { label: "B", printed: "(b)", text: "Colchicine" }, { label: "C", printed: "(c)", text: "Probenecld" }, { label: "D", printed: "(d)", text: "Febuxostat" }] };
  const twin = { ...stored, options: stored.options.map((o) => (o.label === "C" ? { ...o, text: "Probenecid" } : o)) };
  const v2a = v2FieldChecks({ e: stored, twin, model: "m", part: "page 3", sourceText: src, fields: ["option C"], resolvedBySource: false, answer: ans(), typeDiffers: false, missingNumbers: [], memoryUsed: true, unreliableMarks: false });
  check("Verify 2: option C differs → problem with the second read's text as suggestion and source evidence", at(v2a, "option C")?.status === "PROBLEM" && at(v2a, "option C")?.suggestion === "Probenecid" && /contains the suggested wording/.test(at(v2a, "option C")?.evidence ?? "") && /confirmed paper memory/.test(at(v2a, "option C")?.evidence ?? ""), at(v2a, "option C"));
  check("Verify 2: the other options, number, type, answer and source are checked one by one", ["option A", "option B", "option D", "number", "type", "answer", "source"].every((x) => at(v2a, x)?.status === "OK"), v2a.map((x) => [x.field, x.status]));
  const v2b = v2FieldChecks({ e: stored, twin: null, model: "m", part: null, sourceText: null, fields: ["not found"], resolvedBySource: false, answer: ans(), typeDiffers: false, missingNumbers: [], memoryUsed: false, unreliableMarks: false });
  check("Verify 2: not found → a NUMBER problem and no invented suggestion anywhere", at(v2b, "number")?.status === "PROBLEM" && v2b.every((x) => !x.suggestion));
  const v2c = v2FieldChecks({ e: stored, twin, model: "m", part: null, sourceText: src, fields: ["option C"], resolvedBySource: true, answer: ans({ official: [], status: "UNVERIFIED", final: ["B"] }), typeDiffers: false, missingNumbers: ["10"], memoryUsed: false, unreliableMarks: true });
  check("Verify 2: a difference the source settles is OK; numbers missing from the source → SOURCE problem", at(v2c, "option C")?.status === "OK" && at(v2c, "source")?.status === "PROBLEM");
  const v2d = v2FieldChecks({ e: { ...stored, printedAnswer: ["B"] }, twin: { ...twin, printedAnswer: ["C"] }, model: "m", part: null, sourceText: src, fields: [], resolvedBySource: false, answer: ans({ official: [], status: "UNVERIFIED", final: ["B"] }), typeDiffers: false, missingNumbers: [], memoryUsed: true, unreliableMarks: true });
  check("Verify 2: no key + printed answers disagree + memory says marks are unreliable → answer problem, no answer suggested", at(v2d, "answer")?.status === "PROBLEM" && !at(v2d, "answer")?.suggestion && /known to contradict the official key/.test(at(v2d, "answer")?.problem ?? ""), at(v2d, "answer"));
  const board = fieldBoard(v1a, v2a);
  check("board: Verify 1 OK + Verify 2 problem → problem (both notes kept)", board.find((r) => r.field === "option C")?.status === "PROBLEM" && board.find((r) => r.field === "option A")?.status === "OK" && board.find((r) => r.field === "option C")!.notes.length === 2, board.find((r) => r.field === "option C"));
  check("board: a field one check could not verify and another verified → OK", fieldBoard([{ field: "source", status: "NOT_CHECKED", by: "V1" }], [{ field: "source", status: "OK", by: "V2" }])[0].status === "OK");

  // =================================================================================================================
  section("A7. Prompt builders — memory only when confirmed memory applies");
  const plain = extractUserText({ exam: "CMS", subject: null, page: 2, pages: 9, textLayer: null });
  check("no memory → the page request is unchanged (no memory block)", !/PAPER MEMORY/.test(plain) && plain.startsWith("Exam: CMS · Page 2 of 9.\nThis page has no text layer"), plain.slice(0, 120));
  check("the answer-key request without memory is the exact earlier text", keyUserText(3) === "Answer key page 3. DOCUMENT DATA (untrusted): see the image.");
  const withMem = documentTextUserText({ exam: "CMS", subject: null, part: 1, parts: 3, text: "1. Q", memory: brief });
  check("with memory: the block sits before the untrusted document data", withMem.indexOf("PAPER MEMORY") > 0 && withMem.indexOf("PAPER MEMORY") < withMem.indexOf("DOCUMENT DATA"));
  check("classification request carries the classify memory only when given", /PAPER MEMORY/.test(classifyUserText("S1 Surgery", [p25[0]], memoryBrief(rules25, "PAPER II", "classify"))) && !/PAPER MEMORY/.test(classifyUserText("S1 Surgery", [p25[0]])));

  // =================================================================================================================
  section("B. Database — learning from approved corrections, use on a new upload, Verify 1, suggestions");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const qbBefore = await prisma.question.count();
  const exam = await prisma.exam.create({ data: { name: `SYNTHETIC CMS MEM ${RUN}`, code: `SYNMEM${RUN}`.slice(0, 20), isActive: true, durationMinutes: 120, totalQuestions: 120, negativeMarking: 0 } });
  const subject = await prisma.subject.create({ data: { name: "General Medicine", nameKey: `${taxonomyNameKey("General Medicine")}-${RUN}`, originExamId: exam.id, order: 0 } });
  await prisma.examSubject.create({ data: { examId: exam.id, subjectId: subject.id, displayOrder: 0 } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: "Cardiology", nameKey: `${taxonomyNameKey("Cardiology")}-${RUN}`, order: 0 } });
  await prisma.examTopic.create({ data: { examId: exam.id, topicId: topic.id, displayOrder: 0 } });
  const pyp1 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "UPSC CMS PAPER 1" } });
  const pyp2 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "UPSC CMS PAPER 2" } });
  const jobIds: string[] = [];
  const pdf = readFileSync(path.join(FX, t24.file));
  const makeJob = async (title: string, pyp: string) => {
    const stored = await putContent("files", pdf, "pdf");
    const job = await prisma.aiImportJob.create({ data: { title: `${title} ${RUN}`, examId: exam.id, createdById: admin.id, budgetInr: 0, status: AiImportJobStatus.NEEDS_REVIEW, expectedQuestions: 120, previousYearPaperId: pyp } });
    jobIds.push(job.id);
    const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: t24.file, ext: "pdf", declaredBytes: pdf.length, bytes: pdf.length, sha256: stored.sha256, storageKey: stored.key, status: AiImportFileStatus.PROCESSED, detected: { kind: "pdf" }, pageCount: 3, uploadedById: admin.id } });
    return { job, file };
  };
  const row = (jobId: string, fileId: string, e: ExtractedQuestion, i: number, extra: Partial<Prisma.AiImportQuestionUncheckedCreateInput> = {}): Prisma.AiImportQuestionUncheckedCreateInput => ({ jobId, fileId, sourceKey: sourceKeyOf(e) + (e.number === null ? `-${i}` : ""), sourceNumber: e.number, sourceLabel: e.number === null ? `p2-${i}` : e.label, pages: e.pages, orderIndex: i, status: AiImportQuestionStatus.EXTRACTED, data: e as unknown as Prisma.InputJsonValue, questionType: e.type, optionCount: e.options.length, contentFormat: e.contentFormat, confidence: e.confidence, subjectId: subject.id, topicId: topic.id, taxonomySource: "admin", ...extra });
  const ctxOf = async (jobId: string) => ({ job: await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } }), settings: { ...(await getImporterSettings()), aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true });
  // The same production failure, three times: the corrected import (A), a new upload of the same paper (B), Paper II (C).
  const failing = () => [mk(1, INSTRUCTION, 1), mk(null, "The height of the Jugular Venous Pulse is determined by"), mk(5, "Which of the following are major criteria under the Jones Criteria for Acute Rheumatic Fever?"), mk(6, "A 70-year-old man with dyspnoea on exertion has a single second heart sound")];
  const A = await makeJob("CMS 2024 Paper I (corrected)", pyp1.id);
  const aRows = [];
  for (const [i, e] of failing().entries()) aRows.push(await prisma.aiImportQuestion.create({ data: row(A.job.id, A.file.id, e, i, { finalAnswer: ["A"], answerConfirmedById: admin.id, answerStatus: "UNVERIFIED" }) }));

  // The administrator rejects the cover instruction (a confirmed correction) …
  await rejectQuestions([aRows[0].id], admin.id, "cover-page instruction, not a question");
  let rules = await examPaperRules(exam.id);
  check("rejecting the cover instruction proposes INSTRUCTION_AS_QUESTION (PROPOSED)", rules.some((r) => r.kind === "EXTRACTION_ERROR" && r.value.pattern === "INSTRUCTION_AS_QUESTION" && r.status === "PROPOSED"), rules.map((r) => r.key));
  // … then numbers the real Q1 — NOT approved yet → that correction teaches nothing.
  const unnumbered1 = aRows[1];
  const e1 = unnumbered1.data as unknown as ExtractedQuestion;
  await editQuestion(unnumbered1.id, admin.id, { stem: e1.stem.replace("Jugular", "Jugular"), options: e1.options.map((o) => ({ label: o.label, text: o.text })), type: e1.type, contentFormat: e1.contentFormat, number: 1 });
  await learnFromCorrections(A.job.id, admin.id);
  check("an unapproved correction teaches nothing", !(await examPaperRules(exam.id)).some((r) => r.key === "EXTRACTION_ERROR:NUMBER_MISSING"));
  const ap = await approveQuestions([unnumbered1.id], admin.id);
  rules = await examPaperRules(exam.id);
  const nm = rules.find((r) => r.kind === "EXTRACTION_ERROR" && r.value.pattern === "NUMBER_MISSING");
  check("approving it proposes NUMBER_MISSING for PAPER I (PROPOSED, evidence: import, file, SHA-256, admin-confirmed)", ap.approved === 1 && !!nm && nm.status === "PROPOSED" && nm.paper === "PAPER I" && nm.evidence[0].jobId === A.job.id && nm.evidence[0].fileSha256 === A.file.sha256 && nm.evidence[0].source === "ADMIN_CONFIRMED", { ap, rules: rules.map((r) => [r.kind, r.key, r.status]) });
  check("the learning is in the job's events", (await prisma.aiImportEvent.count({ where: { jobId: A.job.id, type: "PAPER_MEMORY_LEARNED" } })) >= 1);
  await approveQuestions([unnumbered1.id], admin.id).catch(() => undefined);
  check("learning again from the same import adds no duplicate evidence", (await examPaperRules(exam.id)).find((r) => r.key === nm!.key)!.evidence.length === 1);

  const B = await makeJob("CMS 2024 Paper I (new upload)", pyp1.id);
  for (const [i, e] of failing().entries()) await prisma.aiImportQuestion.create({ data: row(B.job.id, B.file.id, e, i) });
  const C = await makeJob("CMS 2024 Paper II", pyp2.id);
  for (const [i, e] of failing().entries()) await prisma.aiImportQuestion.create({ data: row(C.job.id, C.file.id, e, i) });
  await runPostProcessing(await ctxOf(B.job.id));
  let bq = await prisma.aiImportQuestion.findMany({ where: { jobId: B.job.id }, orderBy: { orderIndex: "asc" }, include: { checks: true } });
  check("PROPOSED rules are not used: the new upload has no paper-memory flag and no memory text", bq.every((x) => !JSON.stringify(x.issues ?? {}).includes("Paper memory")) && (await jobMemoryBrief(B.job, "extract")) === "");

  for (const r of await examPaperRules(exam.id)) await decidePaperRule(exam.id, admin.id, r.id, "CONFIRMED", "checked against the source");
  const dataBefore = new Map(bq.map((x) => [x.id, JSON.stringify({ stem: (x.data as unknown as ExtractedQuestion).stem, options: (x.data as unknown as ExtractedQuestion).options, number: (x.data as unknown as ExtractedQuestion).number, editedData: x.editedData, finalAnswer: x.finalAnswer })]));
  await runPostProcessing(await ctxOf(B.job.id));
  bq = await prisma.aiImportQuestion.findMany({ where: { jobId: B.job.id }, orderBy: { orderIndex: "asc" }, include: { checks: true } });
  const flag = (x: (typeof bq)[number]) => (x.issues as Record<string, string> | null)?.FORMAT_DEVIATION ?? "";
  check("CONFIRMED: the new upload's cover instruction is flagged on import (FORMAT_DEVIATION, paper memory)", bq[0].issueCodes.includes("FORMAT_DEVIATION") && /instruction to candidates/.test(flag(bq[0])), [bq[0].issueCodes, bq[0].issues]);
  check("CONFIRMED: the question read without its number is flagged", bq[1].issueCodes.includes("FORMAT_DEVIATION") && /number/.test(flag(bq[1])), [bq[1].issueCodes, bq[1].issues]);
  check("correct questions are not flagged by memory; a “Paper memory” check is recorded on each question", !flag(bq[2]) && !flag(bq[3]) && bq.every((x) => x.checks.some((c) => c.name === "Paper memory")), bq.map((x) => [x.sourceLabel, flag(x)]));
  check("nothing was changed by memory (text, options, number, answer)", bq.every((x) => dataBefore.get(x.id) === JSON.stringify({ stem: (x.data as unknown as ExtractedQuestion).stem, options: (x.data as unknown as ExtractedQuestion).options, number: (x.data as unknown as ExtractedQuestion).number, editedData: x.editedData, finalAnswer: x.finalAnswer })));
  const briefB = await jobMemoryBrief(B.job, "extract");
  check("the new upload's AI requests get the confirmed PAPER I memory; Paper II's get none", /instruction to candidates/.test(briefB) && /number was not read/.test(briefB) && (await jobMemoryBrief(C.job, "extract")) === "", briefB);
  await runPostProcessing(await ctxOf(C.job.id));
  check("Paper II (same failure) is not flagged by PAPER I rules", (await prisma.aiImportQuestion.findMany({ where: { jobId: C.job.id } })).every((x) => !x.issueCodes.includes("FORMAT_DEVIATION")));

  // Verify 1 of the new upload: field by field, memory included.
  const approvedB = bq[3];
  await prisma.aiImportQuestion.update({ where: { id: approvedB.id }, data: { approvedById: admin.id, approvedAt: new Date(), finalAnswer: ["B"], answerConfirmedById: admin.id } });
  const approvedBefore = JSON.stringify((await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: approvedB.id } })).editedData);
  await runVerify1(B.job.id, admin.id);
  bq = await prisma.aiImportQuestion.findMany({ where: { jobId: B.job.id }, orderBy: { orderIndex: "asc" }, include: { checks: true } });
  const v1Of = (x: (typeof bq)[number]) => (x.data as unknown as ExtractedQuestion).paperVerify?.v1;
  check("Verify 1 records field checks for every question", bq.every((x) => (v1Of(x)?.fieldChecks?.length ?? 0) >= 10), bq.map((x) => v1Of(x)?.fieldChecks?.length));
  check("Verify 1: the cover instruction fails on TEXT by paper memory, with the rule id recorded", v1Of(bq[0])?.passed === false && v1Of(bq[0])!.fieldChecks!.some((c) => c.field === "text" && c.status === "PROBLEM" && c.by === "MEMORY") && (v1Of(bq[0])!.memoryRules ?? []).length > 0, v1Of(bq[0])?.fieldChecks);
  check("Verify 1: the unnumbered question fails on NUMBER", v1Of(bq[1])!.fieldChecks!.some((c) => c.field === "number" && c.status === "PROBLEM"));
  check("Verify 1: an answer an administrator set is OK as admin-set; without an official key it is never called official", v1Of(bq[3])!.fieldChecks!.find((c) => c.field === "answer")?.status === "OK" && /administrator/.test(v1Of(bq[3])!.fieldChecks!.find((c) => c.field === "answer")?.evidence ?? ""));
  check("Verify 1 did not change the approved question or its answer", JSON.stringify((await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: approvedB.id } })).editedData) === approvedBefore && (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: approvedB.id } })).finalAnswer.join() === "B");

  // A Verify 2 suggestion (a current result) taken by the administrator, recorded, then learnable once approved.
  const target = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: bq[2].id }, include: { figures: true } });
  const te = target.data as unknown as ExtractedQuestion;
  const ocrStem = te.stem.replace("Rheumatic", "Rheurnatic");
  await prisma.aiImportQuestion.update({ where: { id: target.id }, data: { data: { ...te, stem: ocrStem } as unknown as Prisma.InputJsonValue } });
  const t2 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: target.id }, include: { figures: true } });
  const e2 = t2.data as unknown as ExtractedQuestion;
  const fp2 = fingerprintsOf({ e: e2, finalAnswer: t2.finalAnswer, subjectId: t2.subjectId, topicId: t2.topicId, subTopicId: t2.subTopicId, figures: t2.figures });
  const v2 = { ...stampOf(fp2), at: NOW, model: "mockvision/checker", status: "DISAGREE" as const, fields: ["question text"], detail: "question text differs", fieldChecks: v2FieldChecks({ e: e2, twin: { ...e2, stem: te.stem }, model: "mockvision/checker", part: "page 2", sourceText: null, fields: ["question text"], resolvedBySource: false, answer: ans({ final: [], official: [], status: "KEY_MISSING" }), typeDiffers: false, missingNumbers: [], memoryUsed: true, unreliableMarks: false }), memoryUsed: true };
  await prisma.aiImportQuestion.update({ where: { id: t2.id }, data: { data: { ...e2, paperVerify: { ...(e2.paperVerify ?? {}), v2 } } as unknown as Prisma.InputJsonValue } });
  check("an answer suggestion is never applied this way", await refused(() => applyVerifySuggestion(t2.id, admin.id, "answer", "V2"), /Only a question-text or option suggestion/));
  await applyVerifySuggestion(t2.id, admin.id, "text", "V2");
  const t3 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: t2.id }, include: { versions: true } });
  check("the administrator's click takes the suggestion as a correction: original kept, history noted, approval withdrawn", (t3.editedData as unknown as ExtractedQuestion).stem === te.stem && (t3.data as unknown as ExtractedQuestion).stem === ocrStem && t3.versions.some((v) => v.kind === "ADMIN_EDIT" && /accepted Verify 2 suggestion for text/.test(v.note ?? "")) && !t3.approvedById, t3.versions.map((v) => v.note));
  check("the same (now out-of-date) suggestion cannot be applied again", await refused(() => applyVerifySuggestion(t2.id, admin.id, "text", "V2"), /out of date/));
  check("the accepted suggestion teaches nothing until the question is approved", !(await examPaperRules(exam.id)).some((r) => r.kind === "OCR_CONFUSION"));
  await prisma.aiImportQuestion.update({ where: { id: t2.id }, data: { finalAnswer: ["A"], answerConfirmedById: admin.id } });
  const ap2 = await approveQuestions([t2.id], admin.id);
  const ocrRule = (await examPaperRules(exam.id)).find((r) => r.kind === "OCR_CONFUSION");
  check("after approval: “Rheurnatic” → “Rheumatic” proposed as an OCR confusion of PAPER I (PROPOSED)", ap2.approved === 1 && ocrRule?.value.wrong === "Rheurnatic" && ocrRule.status === "PROPOSED" && ocrRule.paper === "PAPER I", { ap2, ocrRule });

  check("no AI request was made by any of this", (await prisma.aiImportAiCall.count({ where: { jobId: { in: jobIds } } })) === 0);
  check("the Question Bank was never touched (nothing imported or published)", (await prisma.question.count()) === qbBefore && (await prisma.aiImportQuestion.count({ where: { jobId: { in: jobIds }, questionId: { not: null } } })) === 0);
  check("every memory change is audited", (await prisma.auditLog.count({ where: { entityId: exam.id, action: { in: ["AI_IMPORT_PAPER_MEMORY_LEARNED", "AI_IMPORT_PAPER_RULE_CONFIRMED"] } } })) >= 3);
  void confirmedRulesFor;

  if (!process.env.KEEP) {
    await prisma.aiImportJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.setting.deleteMany({ where: { key: `ai.importer.taxonomyMemory:${exam.id}` } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: exam.id } });
    await prisma.examTopic.deleteMany({ where: { examId: exam.id } });
    await prisma.examSubject.deleteMany({ where: { examId: exam.id } });
    await prisma.topic.deleteMany({ where: { subject: { originExamId: exam.id } } });
    await prisma.subject.deleteMany({ where: { originExamId: exam.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
