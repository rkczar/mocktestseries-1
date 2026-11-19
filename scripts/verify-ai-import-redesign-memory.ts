/**
 * Importer redesign P3 — "Memory" suite (no AI, no network; DB part on a disposable scratch DB, rows prefixed "P3-").
 *
 *   1 paper identity regex + one key for single-paper exams   6 flag-only formula / notation memory
 *   2 evidence tagged by edition (year): no false contradiction  7 exam isolation (CMS rules never reach FSO)
 *   3 "Confirm all eligible" (admin click only)                8 CMS initial memory PROPOSED offline (no DB write)
 *   4 OCR learning filter (script swap, number, not in source)   9 memory never rewrites content or answers
 *   5 checkable format memory (statement + match shapes)        P preservation: FSO-shaped row byte-identical when
 *                                                                 nothing is learned; confirmed items never removed
 *
 *   DOTENV_CONFIG_PATH=/dev/null PG_POOL_MAX=3 DATABASE_URL=<.../mts_redesign_p3> AI_IMPORT_DISABLE_KICK=1 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-redesign-memory.ts
 */
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportQuestionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey, getExamTaxonomy } from "@/lib/exam-taxonomy";
import { learnFromCorrections } from "@/lib/ai-import/paper-learn";
import { TAXONOMY_MEMORY_PREFIX, confirmEligiblePaperRules, examPaperRules, jobMemoryBrief, loadExamMemory, refreshExamMemory, savePaperRuleProposals, taxonomyFingerprint } from "@/lib/ai-import/taxonomy-memory";
import { SINGLE_PAPER_KEY, bulkConfirmEligible, confirmedRulesFor, correctionProposals, editionOf, formatShapes, learnPaperRules, memoryBrief, memoryFindings, mergePaperRules, notationPairs, ocrPairs, paperOf, type CorrectionItem, type PaperRule, type PaperRuleEvidence, type PaperRuleProposal } from "@/lib/ai-import/paper-memory";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { proposeCms } from "./ai-import-cms-memory-proposal";

if (!/\/mts_redesign_p3(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be the scratch database mts_redesign_p3.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
const NOW = "2026-11-19T00:00:00.000Z";
let idn = 0;
const newId = () => `r${++idn}`;
const mk = (stem: string, extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion => ({ section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem, options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: `(${l.toLowerCase()})`, text: `option ${l}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "AI_VISION", notes: [], ...extra });
const evd = (jobId: string, edition?: string, extra: Partial<PaperRuleEvidence> = {}): PaperRuleEvidence => ({ jobId, jobTitle: jobId, fileName: `${jobId}.docx`, fileSha256: `sha-${jobId}`, source: "SOURCE_DOCUMENT", detail: "d", supporting: 120, observed: 120, at: NOW, ...(edition ? { edition } : {}), ...extra });
const prop = (key: string, ev: PaperRuleEvidence, paper = "PAPER I"): PaperRuleProposal => ({ scope: "PAPER", paper, kind: key.split(":")[0] as PaperRule["kind"], key, statement: key, value: { v: key }, evidence: ev });
const ctx = { aiRead: true, officialAnswer: true, finalAnswer: ["A"], subjectName: null, fileSha256: null };
const confirmAll = (rules: PaperRule[]) => rules.map((r) => ({ ...r, status: "CONFIRMED" as const }));

async function main() {
  // ===============================================================================================================
  section("1. Paper identity");
  const cases: [string, string | null][] = [["QP-CMSE-26-SrgryGynaeObstPvntSclMdcnPaper-II-03082026", "PAPER II"], ["CMS_2024_Paper_I_General_Medicine", "PAPER I"], ["cms paper1_final", "PAPER I"], ["UPSC CMS PAPER 2", "PAPER II"], ["Paper-III", "PAPER III"], ["cms 2025 1", null], ["FSO Screening Test 2019", null], ["Paper 12", null]];
  for (const [t, want] of cases) check(`paperOf(${JSON.stringify(t)}) = ${want}`, paperOf(t) === want, paperOf(t));
  const single = learnPaperRules({ jobId: "fso", jobTitle: "FSO Screening Test 2019", paper: null, fileName: "f.pdf", fileSha256: "s", at: NOW, source: null, approvedKey: null, approvedSubjects: new Map([["Food Safety", 50]]), ocrCorrections: [] });
  check("single-paper exam: learning stores the one key", single.every((p) => p.paper === SINGLE_PAPER_KEY) && SINGLE_PAPER_KEY === "UNKNOWN PAPER");
  const singleRules = confirmAll(mergePaperRules([], single, NOW, newId).rules);
  check("single-paper exam: its confirmed rules now apply to its imports (paper = null)", confirmedRulesFor(singleRules, null).length === singleRules.length && singleRules.length > 0);
  check("…and the confirmed subject scope flags a subject outside it", memoryFindings(singleRules, null, mk("Some question about law"), { ...ctx, subjectName: "History" }).some((f) => f.field === "subject" && /UNKNOWN PAPER covers/.test(f.detail)));
  check("a PAPER I rule still never applies to PAPER II", confirmedRulesFor(confirmAll(mergePaperRules([], [prop("NUMBERING:N.|restarts:0", evd("a"))], NOW, newId).rules), "PAPER II").length === 0);

  // ===============================================================================================================
  section("2. Evidence tagged by edition (year)");
  check("editionOf: job year first, then a year in the titles", editionOf(2026, "x 2024") === "2026" && editionOf(null, null, "QP-CMSE-26-…-03082026") === null && editionOf(null, "CMS 2013 Paper I") === "2013" && editionOf(null, "cMS 2024 2") === "2024");
  const y25 = mergePaperRules([], [prop("ANSWER_MARK:a", evd("j25", "2025"))], NOW, newId).rules.map((r) => ({ ...r, status: "CONFIRMED" as const }));
  const y26 = mergePaperRules(y25, [prop("ANSWER_MARK:b", evd("j26", "2026"))], "2026-11-20T00:00:00.000Z", newId);
  check("a different value in another edition is NOT a contradiction (2025 rule stays confirmed)", y26.contradicted === 0 && y26.rules.find((r) => r.key === "ANSWER_MARK:a")!.status === "CONFIRMED" && !y26.rules.find((r) => r.key === "ANSWER_MARK:a")!.contradictedBy, y26);
  const both = y26.rules.map((r) => ({ ...r, status: "CONFIRMED" as const }));
  check("both confirmed: the newest edition's rule is the one used", confirmedRulesFor(both, "PAPER I").map((r) => r.key).join() === "ANSWER_MARK:b");
  const same = mergePaperRules(y25, [prop("ANSWER_MARK:b", evd("j25b", "2025"))], NOW, newId);
  check("a different value in the SAME edition is still a contradiction", same.contradicted === 1 && same.rules.find((r) => r.key === "ANSWER_MARK:a")!.status === "PROPOSED");
  const legacy = mergePaperRules(mergePaperRules([], [prop("ANSWER_MARK:a", evd("old"))], NOW, newId).rules, [prop("ANSWER_MARK:b", evd("j26", "2026"))], NOW, newId);
  check("legacy evidence without an edition keeps the old behaviour (contradiction)", legacy.contradicted === 1);

  // ===============================================================================================================
  section("3. Confirm all eligible (pure)");
  const base = (over: Partial<PaperRule>): PaperRule => ({ ...mergePaperRules([], [prop("NUMBERING:N.|restarts:0", evd("e1"))], NOW, newId).rules[0], ...over });
  check("eligible: one source document with ≥50 supporting at 100 %", bulkConfirmEligible(base({})));
  check("eligible: two different files", bulkConfirmEligible(base({ evidence: [evd("a", undefined, { source: "OFFICIAL_KEY", supporting: 5, observed: 5 }), evd("b", undefined, { source: "OFFICIAL_KEY", supporting: 5, observed: 5 })], confidence: 1 })));
  check("not eligible: contradicted / low confidence / confirmed / one small file", !bulkConfirmEligible(base({ contradictedBy: "x" })) && !bulkConfirmEligible(base({ confidence: 0.9 })) && !bulkConfirmEligible(base({ status: "CONFIRMED" })) && !bulkConfirmEligible(base({ evidence: [evd("a", undefined, { supporting: 10, observed: 10 })] })));
  check("not eligible: OCR and notation rules (one by one)", !bulkConfirmEligible(base({ kind: "OCR_CONFUSION" })) && !bulkConfirmEligible(base({ kind: "NOTATION" })));

  // ===============================================================================================================
  section("4. OCR learning filter");
  check("Devanagari ↔ Latin swap is not OCR", ocrPairs("भारत is large", "India is large").length === 0);
  check("a number change is a content edit, not OCR", ocrPairs("in 1885 the", "in 1889 the").length === 0);
  check("quote normalisation is not OCR", ocrPairs("the Bank’s rate", "the Bank's rate").length === 0);
  check("an admin typo absent from the source text is not learned", ocrPairs("was chosen by", "was choosen by", "Which was chosen by the board?").length === 0);
  check("a real OCR fix present in the source text IS learned", JSON.stringify(ocrPairs("(c) Gluococortids", "(c) Glucocorticoids", "(c) Glucocorticoids and more")) === JSON.stringify([{ wrong: "Gluococortids", right: "Glucocorticoids" }]));
  check("no source text (null / empty) → nothing learned; not given (legacy caller) → unchecked", ocrPairs("(c) Gluococortids", "(c) Glucocorticoids", null).length === 0 && ocrPairs("(c) Gluococortids", "(c) Glucocorticoids", "").length === 0 && ocrPairs("(c) Gluococortids", "(c) Glucocorticoids").length === 1);
  const fsoItems: CorrectionItem[] = [
    { fileId: "f", label: "1", kind: "EDIT", before: mk("सिंगापुर is an island"), after: mk("Singapore is an island"), aiRead: true, acceptedSuggestion: false, sourceText: "Singapore is an island" },
    { fileId: "f", label: "2", kind: "EDIT", before: mk("He was chosen in 1885"), after: mk("He was choosen in 1889"), aiRead: true, acceptedSuggestion: false, sourceText: "He was chosen in 1885" },
  ];
  check("the FSO baseline's wrong pairs (script swap, typo, year edit) produce no OCR rule", correctionProposals({ jobId: "j", jobTitle: "t", paper: null, at: NOW, files: new Map(), items: fsoItems }).filter((p) => p.kind === "OCR_CONFUSION").length === 0);

  // ===============================================================================================================
  section("5. Format memory is checkable");
  const roman = mk("Consider the following statements:\nI. Alpha is true\nII. Beta is true\nWhich is correct?");
  const arabic = mk("Consider the following statements:\n1. Alpha is true\n2. Beta is true\nWhich is correct?");
  const m44 = mk("Match List I with List II", { type: "MATCH_THE_FOLLOWING", listI: ["A", "B", "C", "D"].map((k) => ({ key: k, text: `l1 ${k}` })), listII: ["1", "2", "3", "4"].map((k) => ({ key: k, text: `l2 ${k}` })) });
  const m43 = { ...m44, listII: m44.listII!.slice(0, 3) };
  check("formatShapes: dominant statement numbering + match shape", JSON.stringify(formatShapes([roman, roman, arabic, m44])) === JSON.stringify({ statementNumbering: "roman", matchShape: "4x4" }), formatShapes([roman, roman, arabic, m44]));
  const typesRule = confirmAll(mergePaperRules([], learnPaperRules({ jobId: "jt", jobTitle: "t", paper: "PAPER I", fileName: "p.docx", fileSha256: "s", at: NOW, source: { questions: [roman, roman, m44], numberStyles: ["N.", "N.", "N."], sectionRestarts: 0 }, approvedKey: null, approvedSubjects: null, ocrCorrections: [] }).filter((p) => p.kind === "QUESTION_TYPES"), NOW, newId).rules);
  check("the stored rule carries the shapes", JSON.stringify(typesRule[0].value.shapes) === JSON.stringify({ statementNumbering: "roman", matchShape: "4x4" }));
  check("statements numbered differently → flagged (text)", memoryFindings(typesRule, "PAPER I", arabic, ctx).some((f) => f.field === "text" && /numbered roman/.test(f.detail)));
  check("a 4x3 match list → flagged (options)", memoryFindings(typesRule, "PAPER I", m43, ctx).some((f) => f.field === "options" && /4x4/.test(f.detail)));
  check("matching questions → no finding", memoryFindings(typesRule, "PAPER I", roman, ctx).length === 0 && memoryFindings(typesRule, "PAPER I", m44, ctx).length === 0);
  check("an old QUESTION_TYPES rule without shapes → no finding (unchanged behaviour)", memoryFindings(typesRule.map((r) => ({ ...r, value: { formats: {}, questions: 3 } })), "PAPER I", arabic, ctx).length === 0);

  // ===============================================================================================================
  section("6. Formula / notation memory (flag only)");
  check("notationPairs: CO2 → CO₂, \\text{mg} → mg, x2 → x²", JSON.stringify(notationPairs("level of CO2 rises", "level of CO₂ rises")) === JSON.stringify([{ wrong: "CO2", right: "CO₂" }]) && notationPairs("dose 5 \\text{mg}", "dose 5 mg").length === 1 && notationPairs("area x2", "area x²").length === 1);
  check("a notation change is not an OCR confusion", ocrPairs("level of CO2 rises", "level of CO₂ rises").length === 0);
  check("an ordinary word fix is not notation", notationPairs("(c) Gluococortids", "(c) Glucocorticoids").length === 0);
  const notaProps = correctionProposals({ jobId: "jn", jobTitle: "t", paper: "PAPER I", at: NOW, files: new Map([["f", { name: "p.docx", sha: "s" }]]), items: [{ fileId: "f", label: "1", kind: "EDIT", before: mk("Normal arterial CO2 tension is"), after: mk("Normal arterial CO₂ tension is"), aiRead: false, acceptedSuggestion: false }] });
  check("learned as a PROPOSED NOTATION rule", notaProps.length === 1 && notaProps[0].kind === "NOTATION");
  const notaRules = mergePaperRules([], notaProps, NOW, newId).rules;
  const q6 = mk("Raised CO2 causes");
  check("proposed → no finding; confirmed → flagged, question unchanged", memoryFindings(notaRules, "PAPER I", q6, ctx).length === 0 && memoryFindings(confirmAll(notaRules), "PAPER I", q6, ctx).some((f) => f.field === "text" && /CO₂/.test(f.detail)) && q6.stem === "Raised CO2 causes");
  check("notation memory never enters an AI prompt", memoryBrief(confirmAll(notaRules), "PAPER I", "extract") === "");

  // ===============================================================================================================
  section("9. Memory never rewrites content or answers");
  const all = confirmAll(mergePaperRules([], [...learnPaperRules({ jobId: "jx", jobTitle: "t", paper: "PAPER I", fileName: "p.docx", fileSha256: "s", at: NOW, source: { questions: [roman, m44], numberStyles: ["N.", "N."], sectionRestarts: 0 }, approvedKey: null, approvedSubjects: new Map([["Medicine", 60]]), ocrCorrections: [{ wrong: "Gluococortids", right: "Glucocorticoids", count: 1 }] }), ...notaProps], NOW, newId).rules);
  const victim = mk("Raised CO2 with Gluococortids\n1. a b\n2. c d", { number: null, printedAnswer: ["B"], options: [{ label: "A", printed: "(a)", text: "x" }] });
  const snap = JSON.stringify(victim);
  const found = memoryFindings(all, "PAPER I", Object.freeze(victim), { ...ctx, subjectName: "Surgery", finalAnswer: ["B"], officialAnswer: false });
  check("findings are produced (flags) …", found.length >= 3, found);
  check("… the question object is untouched", JSON.stringify(victim) === snap);
  check("… a finding holds only field / detail / rule id (no new value, no answer)", found.every((f) => Object.keys(f).sort().join() === "detail,field,ruleId"));
  check("the AI memory block is DATA and forbids supplying text or answers", /never use it to supply text, options, numbers or answers/i.test(memoryBrief(all, "PAPER I", "extract")));

  // ===============================================================================================================
  section("DB setup (P3- rows)");
  const run = Date.now().toString(36);
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const mkExam = async (tag: string) => {
    const exam = await prisma.exam.create({ data: { name: `P3-${tag} ${run}`, code: `P3${tag}${run}`.slice(0, 20), isActive: true, durationMinutes: 120, totalQuestions: 120, negativeMarking: 0 } });
    const subject = await prisma.subject.create({ data: { name: `P3-${tag} Subject`, nameKey: `${taxonomyNameKey(`P3-${tag} Subject`)}-${run}`, originExamId: exam.id, order: 0 } });
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: subject.id, displayOrder: 0 } });
    const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: `P3-${tag} Topic`, nameKey: `${taxonomyNameKey(`P3-${tag} Topic`)}-${run}`, order: 0 } });
    await prisma.examTopic.create({ data: { examId: exam.id, topicId: topic.id, displayOrder: 0 } });
    return { exam, subject, topic };
  };
  const fso = await mkExam("FSO");
  const cms = await mkExam("CMS");
  const fp = taxonomyFingerprint(await getExamTaxonomy(prisma, fso.exam.id));
  const rowMd5 = async (examId: string) => (await prisma.$queryRaw<{ m: string }[]>(Prisma.sql`SELECT md5(value::text) AS m FROM "Setting" WHERE key = ${TAXONOMY_MEMORY_PREFIX + examId}`))[0]?.m ?? null;
  const settingCount = async () => prisma.setting.count();

  // A row shaped like the FSO baseline (D-memory.md §1): version 53, 19 verified examples, 1 proposed example, 16 PROPOSED
  // paper rules under "UNKNOWN PAPER" (no edition on any evidence), 53 history entries, no synonyms / aliases / format rules.
  const ex = (i: number) => ({ id: `c${i}`, text: `example question words number ${i} about food safety`, subjectId: fso.subject.id, topicId: fso.topic.id, subTopicId: null, jobId: "cmwah66bj-fake", questionId: `q${i}`, byId: admin.id, at: NOW, source: "admin correction", verifiedAt: NOW, verifiedById: admin.id });
  const legacyRule = (i: number, kind: PaperRule["kind"], key: string, status: PaperRule["status"] = "PROPOSED"): PaperRule => ({ id: `fsor${i}`, scope: "PAPER", paper: "UNKNOWN PAPER", kind, key, statement: key, value: kind === "OCR_CONFUSION" ? { wrong: key.split(/[:→]/)[1], right: key.split("→")[1] } : { v: i }, supporting: 3, observed: 3, confidence: 1, evidence: [{ jobId: "cmwah66bj-fake", jobTitle: "FSO Screening Test 2019", fileName: "fso.pdf", fileSha256: "fso-sha", source: "ADMIN_CONFIRMED", detail: "3 admin correction(s)", supporting: 3, observed: 3, at: NOW }], status, contradictedBy: null, learnedAt: NOW, updatedAt: NOW, decidedById: null, decidedAt: null, note: null });
  const fsoRules: PaperRule[] = [...["बंगा→Banga", "फिजी→Fiji", "भारत→India", "chosen→choosen", "1885→1889", "Bank’s→Bank's"].map((k, i) => legacyRule(i, "OCR_CONFUSION", `OCR_CONFUSION:${k}`)), legacyRule(20, "ANSWER_KEY_LAYOUT", "ANSWER_KEY_LAYOUT:pdf|AI vision|150"), legacyRule(21, "DROPPED_MARKER", "DROPPED_MARKER:*"), legacyRule(22, "SUBJECT_SCOPE", "SUBJECT_SCOPE:x")];
  const baseline = { examId: fso.exam.id, version: 53, taxonomyFingerprint: fp, synonyms: [], confusions: [], corrections: Array.from({ length: 19 }, (_, i) => ex(i)), proposedCorrections: [{ ...ex(99), verifiedAt: undefined, verifiedById: undefined, status: "PROPOSED", proposedAt: NOW }], quarantinedCorrections: [], headingAliases: [], formatRules: [], paperRules: fsoRules, history: Array.from({ length: 53 }, (_, i) => ({ version: i + 1, at: NOW, byId: admin.id, action: "AI_IMPORT_TAXONOMY_EXAMPLE_PROPOSED", detail: "{}" })), lastRefresh: null, updatedAt: "2026-11-12T11:26:56.093Z" };
  const json = JSON.stringify(baseline);
  await prisma.$executeRaw(Prisma.sql`INSERT INTO "Setting" ("key","value","updatedAt") VALUES (${TAXONOMY_MEMORY_PREFIX + fso.exam.id}, ${json}::jsonb, now())`);
  const before = await rowMd5(fso.exam.id);
  check("FSO-shaped row stored", !!before);

  // ===============================================================================================================
  section("P. Preservation — nothing new learned → byte-identical; something learned → confirmed items kept");
  const loaded = await loadExamMemory(fso.exam.id);
  check("loads unchanged: every array and scalar as stored", !!loaded && loaded.version === 53 && loaded.corrections.length === 19 && loaded.proposedCorrections!.length === 1 && loaded.paperRules!.length === fsoRules.length && loaded.history!.length === 53);
  await refreshExamMemory(fso.exam.id);
  check("load + refresh (classifier path) writes nothing", (await rowMd5(fso.exam.id)) === before);
  check("confirmedRulesFor / memoryBrief on the stored row: nothing confirmed → nothing used", confirmedRulesFor(loaded!.paperRules!, null).length === 0 && memoryBrief(loaded!.paperRules!, null, "extract") === "");
  await savePaperRuleProposals(fso.exam.id, admin.id, "cmwah66bj-fake", []);
  check("learning nothing (no proposals) → row md5 identical", (await rowMd5(fso.exam.id)) === before);
  const relearn = correctionProposals({ jobId: "cmwah66bj-fake", jobTitle: "FSO Screening Test 2019", paper: null, at: "2026-11-19T10:00:00.000Z", files: new Map(), items: fsoItems });
  await savePaperRuleProposals(fso.exam.id, admin.id, "cmwah66bj-fake", relearn);
  check("learning the FSO script-swap / typo / year edits again → nothing new → md5 identical", relearn.length === 0 && (await rowMd5(fso.exam.id)) === before, relearn);
  const sameAgain: PaperRuleProposal[] = [{ scope: "PAPER", paper: "UNKNOWN PAPER", kind: "DROPPED_MARKER", key: "DROPPED_MARKER:*", statement: "DROPPED_MARKER:*", value: { v: 21 }, evidence: { ...fsoRules[7].evidence[0], at: "2026-11-19T11:00:00.000Z" } }];
  await savePaperRuleProposals(fso.exam.id, admin.id, "cmwah66bj-fake", sameAgain);
  check("re-learning an identical fact (only the time differs) → md5 identical", (await rowMd5(fso.exam.id)) === before);

  // Learning through the real DB path (learnFromCorrections) with a script-swap edit → nothing learned.
  const job = await prisma.aiImportJob.create({ data: { title: `P3-FSO Screening Test 2019 ${run}`, examId: fso.exam.id, createdById: admin.id, budgetInr: 0, status: AiImportJobStatus.NEEDS_REVIEW, expectedQuestions: 150 } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: "P3-fso.pdf", ext: "pdf", declaredBytes: 1, bytes: 1, sha256: `p3sha${run}`, storageKey: null, status: AiImportFileStatus.PROCESSED, detected: { kind: "pdf" }, pageCount: 1, uploadedById: admin.id } });
  await prisma.aiImportPage.create({ data: { jobId: job.id, fileId: file.id, pageNumber: 1, textLayer: "Singapore is an island. Glucocorticoids are used.", textChars: 50 } });
  const addQ = async (i: number, before: ExtractedQuestion, after: ExtractedQuestion) => {
    const q = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: file.id, sourceKey: `#${i}`, sourceNumber: i, sourceLabel: String(i), pages: [1], orderIndex: i, status: AiImportQuestionStatus.READY, data: before as unknown as Prisma.InputJsonValue, editedData: after as unknown as Prisma.InputJsonValue, questionType: "SINGLE_CORRECT", optionCount: 4, contentFormat: "PLAIN", confidence: 0.9, approvedById: admin.id, subjectId: fso.subject.id } });
    await prisma.aiImportQuestionVersion.create({ data: { questionId: q.id, jobId: job.id, kind: "ADMIN_EDIT", data: before as unknown as Prisma.InputJsonValue, actorId: admin.id } });
  };
  await addQ(1, mk("सिंगापुर is an island"), mk("Singapore is an island"));
  const r0 = await learnFromCorrections(job.id, admin.id);
  check("learnFromCorrections with only a script swap → nothing learned, md5 identical", r0 === null && (await rowMd5(fso.exam.id)) === before, r0);

  // Now something new: a real OCR fix shown by the page text → learned; every stored item survives.
  await addQ(2, mk("(c) Gluococortids are used"), mk("(c) Glucocorticoids are used"));
  const r1 = await learnFromCorrections(job.id, admin.id);
  const after1 = (await loadExamMemory(fso.exam.id))!;
  check("a real OCR fix (in the source text) is learned as PROPOSED", !!r1 && r1.added === 1 && after1.paperRules!.some((r) => r.key === "OCR_CONFUSION:Gluococortids→Glucocorticoids" && r.status === "PROPOSED"), r1);
  // jsonb stores object keys in its own order: compare with sorted keys (the md5 checks above cover the bytes).
  const canon = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
  const keep = (a: unknown, b: unknown) => canon(a) === canon(b);
  check("…corrections (all verifiedAt), proposed examples and every old rule are kept byte-for-byte", keep(after1.corrections, baseline.corrections) && keep(after1.proposedCorrections!, baseline.proposedCorrections) && fsoRules.every((r) => keep(after1.paperRules!.find((x) => x.id === r.id), r)));
  check("…history appended, never reset", after1.history!.length === 54 && keep(after1.history!.slice(0, 53), baseline.history) && after1.version === 54);
  // Confirmed items are never removed or demoted by later learning.
  const confirmedId = fsoRules[8].id;
  await prisma.$executeRaw(Prisma.sql`UPDATE "Setting" SET value = jsonb_set(value, '{paperRules,8,status}', '"CONFIRMED"') WHERE key = ${TAXONOMY_MEMORY_PREFIX + fso.exam.id}`);
  await savePaperRuleProposals(fso.exam.id, admin.id, job.id, [{ ...prop("NOTATION:CO2→CO₂", evd(job.id, "2019", { source: "ADMIN_CONFIRMED" }), "UNKNOWN PAPER"), value: { wrong: "CO2", right: "CO₂" } }]);
  const after2 = (await loadExamMemory(fso.exam.id))!;
  check("a confirmed rule stays CONFIRMED and byte-identical when something new is learned", after2.paperRules!.find((r) => r.id === confirmedId)?.status === "CONFIRMED" && after2.corrections.length === 19 && after2.paperRules!.length === after1.paperRules!.length + 1, after2.paperRules!.find((r) => r.id === confirmedId));
  await savePaperRuleProposals(fso.exam.id, admin.id, job.id, [prop("SUBJECT_SCOPE:y", evd(job.id, "2019"), "UNKNOWN PAPER")]);
  const after3 = (await loadExamMemory(fso.exam.id))!;
  check("a legacy (no-edition) confirmed rule contradicted by a new value is sent back to review, never removed", after3.paperRules!.some((r) => r.id === confirmedId && r.status === "PROPOSED" && r.contradictedBy === "SUBJECT_SCOPE:y" && r.evidence.length === 1));

  // ===============================================================================================================
  section("3. Confirm all eligible (DB, admin action)");
  await savePaperRuleProposals(cms.exam.id, admin.id, "p3-cms", [prop("NUMBERING:N.|restarts:0", evd("p3-cms-a", "2024")), prop("OPTION_LABELS:(a)", evd("p3-cms-a", "2024", { supporting: 10, observed: 10 })), { ...prop("OCR_CONFUSION:Glucose→Glucoze", evd("p3-cms-a", "2024")), value: { wrong: "Glucose", right: "Glucoze" } }]);
  const cmsRules = await examPaperRules(cms.exam.id);
  const shown = cmsRules.filter(bulkConfirmEligible).map((r) => r.id);
  check("only the strong rule is shown as eligible", shown.length === 1 && cmsRules.find((r) => r.id === shown[0])!.kind === "NUMBERING");
  check("nothing is confirmed before the click", (await examPaperRules(cms.exam.id)).every((r) => r.status === "PROPOSED"));
  const res = await confirmEligiblePaperRules(cms.exam.id, admin.id, cmsRules.map((r) => r.id));
  const afterBulk = await examPaperRules(cms.exam.id);
  check("the click confirms exactly the eligible rules (not OCR, not weak) with actor + note", res.confirmed.join() === shown.join() && afterBulk.filter((r) => r.status === "CONFIRMED").map((r) => r.id).join() === shown.join() && afterBulk.find((r) => r.id === shown[0])!.decidedById === admin.id);
  let refused = false;
  try {
    await confirmEligiblePaperRules(cms.exam.id, admin.id, shown);
  } catch {
    refused = true;
  }
  check("a second click with nothing eligible is refused", refused);
  check("audit log written", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_PAPER_RULES_BULK_CONFIRMED", entityId: cms.exam.id } })) === 1);

  // ===============================================================================================================
  section("7. Exam isolation — CMS rules never reach FSO");
  const fsoJob = { examId: fso.exam.id, title: "P3-FSO Screening Test 2019", previousYearPaperId: null };
  const fsoRulesNow = await examPaperRules(fso.exam.id);
  check("FSO's rules contain no CMS rule", !fsoRulesNow.some((r) => afterBulk.some((c) => c.id === r.id)));
  check("FSO import's memory brief has no CMS fact", !/NUMBERING|restarts/.test(await jobMemoryBrief(fsoJob, "extract")) && !(await jobMemoryBrief(fsoJob, "key")).includes("N.|restarts"));
  check("a FSO question gets no finding from CMS's confirmed rules (loaded per exam)", memoryFindings(fsoRulesNow, null, mk("x", { number: null }), ctx).every((f) => !afterBulk.some((c) => c.id === f.ruleId)));
  await prisma.$executeRaw(Prisma.sql`INSERT INTO "Setting" ("key","value","updatedAt") VALUES (${TAXONOMY_MEMORY_PREFIX + "P3-mismatch-" + run}, ${JSON.stringify({ ...baseline, examId: cms.exam.id })}::jsonb, now())`);
  check("a row whose examId names another exam is never loaded", (await loadExamMemory(`P3-mismatch-${run}`)) === null);

  // ===============================================================================================================
  section("8. CMS initial memory — PROPOSED, offline");
  const settingsBefore = await settingCount();
  const md5Fso = await rowMd5(fso.exam.id);
  const proposal = await proposeCms();
  check("rules proposed from the 4 CMS papers", proposal.rules.length > 0 && proposal.sources.length === 4, proposal.sources);
  check("every rule PROPOSED (none confirmed)", proposal.status === "PROPOSED" && proposal.rules.every((r) => r.status === "PROPOSED" && !r.decidedById));
  check("evidence only from the 4 CMS jobs (no FSO job)", proposal.rules.every((r) => r.evidence.every((e) => ["cmw2w5irk059z5hkzby3sgrzc", "cmw3rgq5q00eg01kzr3cd5yaw", "cmwk38t5g04yvxckz5qrs111k", "cmwhg4ksj01ksbzkzxy4l1w2k"].includes(e.jobId))));
  check("2024 and 2026 Paper I facts with different values are NOT contradictions (editions)", proposal.rules.every((r) => !r.contradictedBy));
  check("no database write", (await settingCount()) === settingsBefore && (await rowMd5(fso.exam.id)) === md5Fso);

  // Cleanup of P3- rows.
  await prisma.setting.deleteMany({ where: { key: { in: [TAXONOMY_MEMORY_PREFIX + fso.exam.id, TAXONOMY_MEMORY_PREFIX + cms.exam.id, `${TAXONOMY_MEMORY_PREFIX}P3-mismatch-${run}`] } } });
  await prisma.aiImportJob.delete({ where: { id: job.id } });
  for (const t of [fso, cms]) {
    await prisma.examTopic.deleteMany({ where: { examId: t.exam.id } });
    await prisma.examSubject.deleteMany({ where: { examId: t.exam.id } });
    await prisma.topic.delete({ where: { id: t.topic.id } });
    await prisma.subject.delete({ where: { id: t.subject.id } });
    await prisma.exam.delete({ where: { id: t.exam.id } });
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  });
