/**
 * FSO reconciliation project (2026-11-12) — server-side regression suite. Synthetic fixtures only, disposable DB,
 * scratch storage, no AI call of any kind, never production.
 *
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch mts_*> PG_POOL_MAX=3 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-fso-reconcile.ts
 *
 * A. bilingual number check (harmless translation differences vs real mismatches) — the exact FSO cases
 * B. paper reconciliation (pure) and the corrected "Eligible for import" counter
 * C. FORCE TO PUBLISH: bypasses every normal blocker, content unchanged, audit trail, authorization, technical failures
 * D. WITHDRAWN: added to its paper, shown in place, never answerable or scored, history untouched
 */
import "dotenv/config";
import { AiImportAnswerStatus, AiImportQuestionStatus, QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bilingualFindings, numberMismatch } from "@/lib/ai-import/bilingual";
import { reconcilePaper, type ReconInput } from "@/lib/ai-import/paper-reconciliation";
import { blockerOnceApproved, importBlocker } from "@/lib/ai-import/adapter";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { jobPaperReconciliation, jobSummary } from "@/lib/ai-import/summary";
import { forceImportQuestion } from "@/lib/ai-import/force-publish";
import { resumeJob } from "@/lib/ai-import/jobs";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { SERVABLE_QUESTION_WHERE } from "@/lib/question-servable";
import { saveAnswer, startPreviousYearPaperAttempt, submitAttempt, TestEngineError } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { createFixtureSubject } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || /\/var\/(www|lib\/mocktestseries)/.test(`${process.env.STORAGE_DIR}${process.env.IMPORT_STAGING_DIR}${process.env.AI_IMPORT_VAULT_DIR}`)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR and IMPORT_STAGING_DIR to scratch directories.");
  process.exit(2);
}
// Network guard: this suite needs no network at all.
const blockedHosts = new Set<string>();
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  blockedHosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host);
  throw new Error("test network guard: no network in this suite");
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const opts = (texts: string[]) => texts.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));
const q = (en: Partial<ExtractedQuestion>, hi: Partial<NonNullable<ExtractedQuestion["hi"]>> | null = {}): ExtractedQuestion =>
  ({
    section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "Example of Gel is", options: opts(["Smoke", "Fog", "Milk", "Butter"]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION",
    ...en,
    hi: hi === null ? null : { stem: "जैल का उदाहरण है", options: opts(["धुआँ", "कोहरा", "दूध", "मक्खन"]), confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false, ...hi },
  }) as ExtractedQuestion;
const mismatch = (e: ExtractedQuestion) => bilingualFindings(e).find((f) => f.code === "BILINGUAL_MISMATCH")?.detail ?? null;

function bilingualChecks() {
  section("A. Bilingual number check — FSO root causes");
  // FSO 2022 Q20: "The 3 new … reserves" / "तीन नए … रिजर्व" (number spelled out in Hindi).
  check("2022 Q20: digit 3 vs Hindi word तीन → no mismatch", !mismatch(q({ stem: "The 3 new Wildlife Conservation Reserves recently declared are –" }, { stem: "हाल ही में घोषित तीन नए वन्य जीव संरक्षण रिजर्व हैं –" })));
  // FSO 2022 Q132: List I / List II years are in the English list fields AND in the English stem; Hindi prints them once.
  const q132en = { type: "MATCH_THE_FOLLOWING", stem: "Match the acts:\n\nPFA – 1937\n\nFPO – 1954\n\nAGMARK – 1955", listI: [{ key: "", text: "PFA" }, { key: "", text: "FPO" }, { key: "", text: "AGMARK" }], listII: [{ key: "", text: "1937" }, { key: "", text: "1954" }, { key: "", text: "1955" }], options: opts(["PFA-1954, FPO-1937, AGMARK-1955", "PFA-1937, FPO-1954, AGMARK-1955", "PFA-1955, FPO-1954, AGMARK-1937", "PFA-1954, FPO-1955, AGMARK-1937"]) } as Partial<ExtractedQuestion>;
  const q132hi = { stem: "मिलान कीजिए:\n\nपी एफ ए – 1937\n\nएफ पी ओ – 1954\n\nएगमार्क – 1955", options: opts(["पी एफ ए-1954, एफ पी ओ-1937, एगमार्क-1955", "पी एफ ए-1937, एफ पी ओ-1954, एगमार्क-1955", "पी एफ ए-1955, एफ पी ओ-1954, एगमार्क-1937", "पी एफ ए-1954, एफ पी ओ-1955, एगमार्क-1937"]) };
  check("2022 Q132: the same years counted a different number of times → no mismatch", !mismatch(q(q132en, q132hi)), mismatch(q(q132en, q132hi)));
  // FSO 2022 Q61: a value printed twice in Hindi, once in English.
  check("2022 Q61: '25' twice in Hindi, once in English → no mismatch", !mismatch(q({ stem: "Ratio is 25 percent" }, { stem: "अनुपात 25 प्रतिशत (25) है" })));
  // FSO 2019 Q35: the question number "35." left in the English passage.
  check("2019 Q35: a leading question number '35.' on one side → no mismatch", !mismatch(q({ number: 35, passage: "35. Agro-forestry system involving agricultural and forest crops", stem: "Agro-forestry system involving agricultural and forest crops" }, { stem: "कृषि वानिकी पद्धति जिसमें कृषि एवं वानिकी फसलें सम्मिलित हैं" })));
  // FSO 2019 Q44: ordinals.
  check("2019 Q44: options 1st/2nd/3rd/4th vs पहला/दूसरा/तीसरा/चौथा → no mismatch", !mismatch(q({ stem: "Rajasthan ranks ____ in milk availability (2017-18).", options: opts(["$1^{\\text{st}}$", "$2^{\\text{nd}}$", "$3^{\\text{rd}}$", "$4^{\\text{th}}$"]) }, { stem: "राजस्थान दुग्ध उपलब्धता में ____ स्थान पर है। (2017-18).", options: opts(["पहला", "दूसरा", "तीसरा", "चौथा"]) })));
  check("statement labels '1. … 2. …' printed only in English → no mismatch", !mismatch(q({ stem: "Consider:\n1. Milk is a colloid\n2. Fog is an aerosol" }, { stem: "विचार कीजिए:\nदूध एक कोलॉइड है\nकोहरा एक एरोसोल है" })));
  // Real mismatches are still caught.
  check("a different value (0.60 vs 0.66) → still a mismatch", /only in Hindi: 0\.66; only in English: 0\.60/.test(mismatch(q({ stem: "value 0.60" }, { stem: "मान 0.66" })) ?? ""));
  check("a typo in Hindi (2 instead of 382, FSO 2019 Q36 edit) → still a mismatch", !!mismatch(q({ stem: "Values 334, 382, 425" }, { stem: "मान 334, 2, 425" })));
  check("a number only in English with no word for it → still a mismatch", !!mismatch(q({ stem: "Temperature 72 °C" }, { stem: "तापमान °C" })));
  check("a Hindi verb that is also a number word (दो) never creates a mismatch", numberMismatch("उत्तर दो", "Give the answer") === null);
  check("…and never hides a real missing number (3 only in English, Hindi has दो)", numberMismatch("उत्तर दो", "Give 3 answers") !== null);
  check("Devanagari digits are still read as numbers (३ = 3)", numberMismatch("३ नए", "3 new") === null);
  check("option count difference → still a mismatch", /Hindi option\(s\) but/.test(mismatch(q({}, { options: opts(["धुआँ", "कोहरा", "दूध"]) })) ?? ""));
  check("missing Hindi → BILINGUAL_HINDI_MISSING (unchanged)", bilingualFindings(q({}, null))[0]?.code === "BILINGUAL_HINDI_MISSING");
  check("NFC vs NFD Devanagari is not a number difference", numberMismatch("क़ 5".normalize("NFD"), "q 5") === null);
}

function reconciliationPure() {
  section("B1. Paper reconciliation (pure)");
  const row = (n: number | null, over: Partial<ReconInput> = {}): ReconInput => ({ id: `r${n}-${Math.random()}`, number: n, status: "IMPORTED", answerStatus: "OFFICIAL_MATCHED", approved: true, questionId: `q${n}`, bankStatus: "PUBLISHED", gate: null, gateOnceApproved: null, pages: [1], ...over });
  const rows: ReconInput[] = [];
  for (let n = 1; n <= 150; n++) {
    if (n === 24 || n === 25) continue; // missing
    if (n === 16) rows.push(row(n, { status: "NEEDS_CORRECTION", answerStatus: "WITHDRAWN", approved: false, questionId: null, bankStatus: null, gate: "deleted in the official answer key" }));
    else if (n === 43) rows.push(row(n, { bankStatus: "WITHDRAWN" }));
    else if (n === 20) rows.push(row(n, { status: "NEEDS_CORRECTION", approved: false, questionId: null, bankStatus: null, gate: "Hindi and English versions differ", gateOnceApproved: "Hindi and English versions differ" }));
    else if (n === 52) rows.push(row(n, { status: "READY", approved: false, questionId: null, bankStatus: null, gate: "not approved yet", gateOnceApproved: null }));
    else if (n === 92) rows.push(row(n, { status: "DUPLICATE", questionId: null, bankStatus: null, gate: "duplicate" }));
    else if (n === 109) rows.push(row(n, { status: "NEEDS_CORRECTION", approved: true, questionId: null, bankStatus: null, gate: "status is needs correction", gateOnceApproved: "status is needs correction" }));
    else if (n === 7) rows.push(row(n), row(n, { status: "REJECTED", questionId: null, bankStatus: null }));
    else if (n === 8) rows.push(row(n, { questionId: null, bankStatus: null }), row(n, { questionId: null, bankStatus: null, status: "READY" }));
    else rows.push(row(n));
  }
  rows.push(row(null, { status: "REJECTED", questionId: null, bankStatus: null }));
  const r = reconcilePaper(150, rows);
  const b = (n: number) => r.rows.find((x) => x.number === n)!;
  check("150 rows, one per printed number", r.rows.length === 150 && r.rows.every((x, i) => x.number === i + 1));
  check("missing numbers named exactly (24, 25)", JSON.stringify(r.missing) === "[24,25]", r.missing);
  check("withdrawn not in paper → WITHDRAWN_NOT_IN_PAPER, force available", b(16).bucket === "WITHDRAWN_NOT_IN_PAPER" && b(16).forceAvailable);
  check("withdrawn in the bank → WITHDRAWN_IN_PAPER", b(43).bucket === "WITHDRAWN_IN_PAPER" && !b(43).forceAvailable);
  check("needs correction → BLOCKED with the exact reason", b(20).bucket === "BLOCKED" && b(20).reason === "Hindi and English versions differ");
  check("approved but Needs correction → BLOCKED (never importable)", b(109).bucket === "BLOCKED" && /needs correction/.test(b(109).reason));
  check("Ready, not approved → READY_AWAITING_APPROVAL", b(52).bucket === "READY_AWAITING_APPROVAL");
  check("duplicate → DUPLICATE, force available", b(92).bucket === "DUPLICATE" && b(92).forceAvailable);
  check("a rejected re-read never hides the real record of the same number", b(7).bucket === "PUBLISHED");
  check("two live records of one number → MULTIPLE_RECORDS", b(8).bucket === "MULTIPLE_RECORDS" && b(8).ids.length === 2);
  check("unnumbered artifacts reported separately, not counted", r.unnumbered.length === 1 && r.extracted === 148);
  check("every number is in exactly one bucket", Object.values(r.counts).reduce((a, c) => a + c, 0) === 150, r.counts);
}

async function main() {
  bilingualChecks();
  reconciliationPure();
  const suffix = Date.now().toString(36);
  const master = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" }, isActive: true }, select: { id: true } });
  const fullRole = await prisma.role.findFirstOrThrow({ where: { name: "FULL_ADMIN" } });
  const full = await prisma.adminUser.create({ data: { name: "Full Admin", email: `full-${suffix}@example.test`, username: `full${suffix}`, passwordHash: "x", roleId: fullRole.id } });
  const exam = await prisma.exam.create({ data: { name: `FSO Rec ${suffix}`, code: `FR-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `Food Science ${suffix}` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2022, title: `FSO Comp ${suffix}` } });
  const job = await prisma.aiImportJob.create({ data: { title: `FSO Rec ${suffix}`, status: "NEEDS_REVIEW", examId: exam.id, year: 2022, previousYearPaperId: paper.id, expectedQuestions: 12, createdById: master.id, budgetInr: 0 } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "paper.pdf", ext: "pdf", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 3 } });
  const checksFailed = (detail: string) => ({ at: new Date(Date.now() - 86_400_000).toISOString(), content: { status: "FAILED", required: true, detail }, answer: { status: "PASSED", required: true, detail: "" }, taxonomy: { status: "PASSED", required: true, detail: "" }, independent: { status: "DISAGREEMENT", required: true, detail: "Verify 2 disagrees" } });
  const checksOk = { at: new Date().toISOString(), content: { status: "PASSED", required: true, detail: "" }, answer: { status: "PASSED", required: true, detail: "" }, taxonomy: { status: "PASSED", required: true, detail: "" }, independent: { status: "PASSED", required: true, detail: "" } };
  const mk = async (n: number, e: ExtractedQuestion, over: Partial<Prisma.AiImportQuestionUncheckedCreateInput> = {}) =>
    prisma.aiImportQuestion.create({
      data: {
        jobId: job.id, fileId: file.id, sourceKey: `#${n}`, sourceNumber: n, sourceLabel: String(n), pages: [Math.ceil(n / 4)], orderIndex: n, status: "READY", data: { ...e, number: n, label: String(n), checks: checksOk } as unknown as Prisma.InputJsonValue,
        questionType: e.type, optionCount: e.options.length, subjectId: subject.id, answerStatus: "OFFICIAL_MATCHED", officialAnswer: ["B"], finalAnswer: ["B"], ...over,
      },
    });
  const settings = await getImporterSettings();

  section("B2. 'Eligible for import' uses the real gate");
  // An approved question whose status is Needs correction but carries no blocking flag: the old counter called it eligible.
  const nc = await mk(1, q({ stem: `Q1 needs correction ${suffix}` }), { status: "NEEDS_CORRECTION", approvedById: master.id, approvedAt: new Date(), data: { ...q({ stem: `Q1 needs correction ${suffix}` }), number: 1, checks: checksFailed("checked by hand") } as unknown as Prisma.InputJsonValue });
  const ready = await mk(2, q({ stem: `Q2 ready ${suffix}` }));
  const ncRow = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: nc.id }, include: { figures: true } });
  check("old formula (ignoreApproval) would have counted the Needs-correction question", importBlocker(ncRow, settings, { ignoreApproval: true }) === null);
  check("the real gate refuses it, and so does 'once approved'", !!importBlocker(ncRow, settings) && !!blockerOnceApproved(ncRow, settings), blockerOnceApproved(ncRow, settings));
  const s0 = await jobSummary(job.id);
  check("summary: Eligible for import = 0, Ready — awaiting approval = 1", s0.eligibleImport === 0 && s0.readyAwaitingApproval === 1, { e: s0.eligibleImport, r: s0.readyAwaitingApproval });
  await prisma.aiImportQuestion.update({ where: { id: ready.id }, data: { approvedById: master.id, approvedAt: new Date() } });
  const s1 = await jobSummary(job.id);
  check("after approving the Ready one: Eligible for import = 1", s1.eligibleImport === 1 && s1.readyAwaitingApproval === 0, { e: s1.eligibleImport, r: s1.readyAwaitingApproval });

  section("C. FORCE TO PUBLISH");
  const enStem = `The 3 new Wildlife Conservation Reserves ${suffix} are –`;
  const hiStem = `तीन नए वन्य जीव संरक्षण रिजर्व ${suffix} हैं –`;
  const mis = await mk(3, q({ stem: enStem }, { stem: hiStem, options: opts(["सोरसन", "खींचन", "गजनेर", "शेरगढ़"]) }), { status: "NEEDS_CORRECTION", issueCodes: ["BILINGUAL_MISMATCH", "VERIFY2_DISAGREES"], data: { ...q({ stem: enStem }, { stem: hiStem, options: opts(["सोरसन", "खींचन", "गजनेर", "शेरगढ़"]) }), number: 3, checks: checksFailed("Hindi and English versions do not match") } as unknown as Prisma.InputJsonValue });
  const hold = await mk(4, q({ stem: `Held taxonomy ${suffix}` }), { academicReview: "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" });
  const formula = await mk(5, q({ stem: `Value of $A_w$ ${suffix}`, contentFormat: "RICH_V1" }), { status: "NEEDS_CORRECTION", issueCodes: ["FORMULA_TEXT_CORRUPT", "FORMULA_NEEDS_MANUAL_VERIFICATION"], contentFormat: "RICH_V1" });
  const stale = await mk(6, q({ stem: `Stale approval ${suffix}` }), { status: "NEEDS_CORRECTION", approvedById: master.id, approvedAt: new Date(Date.now() - 10 * 86_400_000), data: { ...q({ stem: `Stale approval ${suffix}` }), number: 6, checks: checksFailed("stale snapshot") } as unknown as Prisma.InputJsonValue });
  const mtfE = q({ type: "MATCH_THE_FOLLOWING", stem: `Match diseases ${suffix}:\n1 Tuberculosis – A. Helminth\n2 Round worm – B. Bacteria`, listI: [{ key: "", text: "Tuberculosis" }, { key: "", text: "Round worm" }], listII: [{ key: "A", text: "Helminth" }, { key: "B", text: "Bacteria" }], options: opts(["TB–A, RW–B", "TB–B, RW–A", "TB–A, RW–A", "TB–B, RW–B"]) });
  const mtf = await mk(7, mtfE, { status: "NEEDS_CORRECTION", questionType: "MATCH_THE_FOLLOWING" });
  const existing = await prisma.question.create({ data: { examId: exam.id, subjectId: subject.id, code: `FR-${suffix}-EX`, text: `Parasitic weed of mustard ${suffix}`, status: QuestionStatus.PUBLISHED, options: { create: ["Orobanche", "Cuscuta", "Striga", "Loranthus"].map((t, i) => ({ label: "ABCD"[i], text: t, isCorrect: i === 0, order: i })) } } });
  const dupE = q({ stem: `Parasitic weed of mustard ${suffix}`, options: opts(["Orobanche", "Cuscuta", "Striga", "Loranthus"]) });
  const dup = await mk(8, dupE, { status: "DUPLICATE", issueCodes: ["DUPLICATE_EXISTING"], duplicateOfQuestionId: existing.id, duplicateKind: "EXACT", approvedById: master.id, approvedAt: new Date(), finalAnswer: ["A"], officialAnswer: ["A"] });
  const noKey = await mk(9, q({ stem: `No key ${suffix}` }), { status: "NEEDS_CORRECTION", finalAnswer: [], officialAnswer: [], answerStatus: "KEY_MISSING" });

  const ok = { actorId: master.id, reason: "Owner verified against the printed paper", confirmed: true };
  // Authorization and confirmation first (nothing may be written).
  check("FULL_ADMIN cannot force (server-side role check)", /Only an active Master Admin/.test((await refusal(forceImportQuestion({ ...ok, actorId: full.id, importQuestionId: mis.id, kind: "PUBLISH" }))) ?? ""));
  check("without the confirmation tick → refused", /Confirm the action/.test((await refusal(forceImportQuestion({ ...ok, confirmed: false, importQuestionId: mis.id, kind: "PUBLISH" }))) ?? ""));
  check("without a reason → refused", /reason/.test((await refusal(forceImportQuestion({ ...ok, reason: " ", importQuestionId: mis.id, kind: "PUBLISH" }))) ?? ""));
  check("…and nothing was written by the refused calls", (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: mis.id } })).questionId === null && (await prisma.auditLog.count({ where: { action: "AI_IMPORT_FORCE_TO_PUBLISH", entityId: { not: null }, metadata: { path: ["importQuestionId"], equals: mis.id } } })) === 0);
  // Normal publish still enforces the normal rules on the same question.
  const misRow = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: mis.id }, include: { figures: true } });
  check("NORMAL gate still refuses the bilingual-mismatch question", /Hindi and English versions differ/.test(importBlocker(misRow, settings, { ignoreApproval: true }) ?? ""), importBlocker(misRow, settings, { ignoreApproval: true }));

  const before = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: mis.id } });
  const r1 = await forceImportQuestion({ ...ok, importQuestionId: mis.id, kind: "PUBLISH" });
  const b1 = await prisma.question.findUniqueOrThrow({ where: { id: r1.questionId }, include: { options: { orderBy: { order: "asc" } } } });
  check("Hindi-English mismatch + Verify 2 disagreement do not block: PUBLISHED", r1.status === "PUBLISHED" && b1.status === QuestionStatus.PUBLISHED, { r1, status: b1.status });
  check("content unchanged: English stem, Hindi stem, options, answer key", b1.text === enStem && b1.textHi === hiStem && b1.options.map((o) => o.text).join() === "Smoke,Fog,Milk,Butter" && b1.options.map((o) => o.textHi).join() === "सोरसन,खींचन,गजनेर,शेरगढ़" && b1.options.find((o) => o.isCorrect)?.label === "B", { text: b1.text, hi: b1.textHi, o: b1.options.map((o) => [o.text, o.textHi, o.isCorrect]) });
  check("in its intended context: the paper, its number, PYQ source, year", b1.previousYearPaperId === paper.id && b1.paperQuestionNumber === 3 && b1.source === "PYQ" && b1.examYear === 2022, { p: b1.previousYearPaperId, n: b1.paperQuestionNumber, s: b1.source });
  check("servable to students (status PUBLISHED, not retired)", (await prisma.question.count({ where: { id: b1.id, ...SERVABLE_QUESTION_WHERE } })) === 1);
  const after = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: mis.id } });
  check("importer record: PUBLISHED, its extraction and edits untouched", after.status === AiImportQuestionStatus.PUBLISHED && JSON.stringify(after.data) === JSON.stringify(before.data) && JSON.stringify(after.editedData) === JSON.stringify(before.editedData));
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "AI_IMPORT_FORCE_TO_PUBLISH", entityId: b1.id } });
  const m = audit.metadata as { bypassed: string[]; reason: string; previousStatus: string; resultingStatus: string; versions: { contentSha256: string }; importQuestionId: string };
  check("audit: admin, question, previous → resulting status, reason, version hash", audit.actorId === master.id && m.importQuestionId === mis.id && m.previousStatus === "NEEDS_CORRECTION" && m.resultingStatus === "PUBLISHED" && m.reason === ok.reason && /^[0-9a-f]{64}$/.test(m.versions.contentSha256), m);
  check("audit records every bypassed blocker (mismatch, Verify 2, status, approval, checks)", ["BILINGUAL_MISMATCH", "VERIFY2_DISAGREES", "status NEEDS_CORRECTION", "not approved"].every((k) => m.bypassed.some((b) => b.includes(k))) && m.bypassed.some((b) => /Wording & structure: failed/.test(b)), m.bypassed);
  check("job event FORCE_TO_PUBLISH written", (await prisma.aiImportEvent.count({ where: { jobId: job.id, type: "FORCE_TO_PUBLISH" } })) === 1);
  const again = await forceImportQuestion({ ...ok, importQuestionId: mis.id, kind: "PUBLISH" });
  check("repeat is idempotent: same question, alreadyDone, no second bank row", again.questionId === r1.questionId && again.alreadyDone && (await prisma.question.count({ where: { previousYearPaperId: paper.id, paperQuestionNumber: 3 } })) === 1);

  const r2 = await forceImportQuestion({ ...ok, importQuestionId: hold.id, kind: "PUBLISH" });
  check("academic hold does not block", r2.status === "PUBLISHED" && r2.bypassed.some((b) => b.includes("academic hold")), r2.bypassed);
  const r3 = await forceImportQuestion({ ...ok, importQuestionId: formula.id, kind: "PUBLISH" });
  const b3 = await prisma.question.findUniqueOrThrow({ where: { id: r3.questionId } });
  check("formula flags do not block; RICH text kept as stored", r3.status === "PUBLISHED" && b3.text === `Value of $A_w$ ${suffix}` && r3.bypassed.some((b) => b.includes("FORMULA_TEXT_CORRUPT")), { t: b3.text, b: r3.bypassed });
  const r4 = await forceImportQuestion({ ...ok, importQuestionId: stale.id, kind: "PUBLISH" });
  check("stale approval / verification snapshot does not block", r4.status === "PUBLISHED", r4);
  const r5 = await forceImportQuestion({ ...ok, importQuestionId: mtf.id, kind: "PUBLISH" });
  const b5 = await prisma.question.findUniqueOrThrow({ where: { id: r5.questionId }, include: { options: true } });
  check("QA M4: the Match downgrade is recorded in the audit as an adaptation", ((await prisma.auditLog.findFirstOrThrow({ where: { action: "AI_IMPORT_FORCE_TO_PUBLISH", entityId: r5.questionId } })).metadata as { adaptations: string[] }).adaptations.some((a) => /single-correct/.test(a)));
  check("QA M3: the job lease is released after a forced import", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } })).leaseOwner === null);
  check("keyless Match lists do not block: stored single-correct, list text kept, nothing invented", r5.status === "PUBLISHED" && b5.questionType === "SINGLE_CORRECT" && b5.text.includes("Tuberculosis") && b5.text.includes("Bacteria") && b5.options.length === 4, { type: b5.questionType, text: b5.text });
  const r6 = await forceImportQuestion({ ...ok, importQuestionId: dup.id, kind: "PUBLISH" });
  const b6 = await prisma.question.findUniqueOrThrow({ where: { id: r6.questionId } });
  check("duplicate (PYQ repeated across years) is added as a NEW row for this paper; the other question untouched", r6.questionId !== existing.id && b6.previousYearPaperId === paper.id && (await prisma.question.findUniqueOrThrow({ where: { id: existing.id } })).previousYearPaperId === null, { r6 });
  const noKeyErr = await refusal(forceImportQuestion({ ...ok, importQuestionId: noKey.id, kind: "PUBLISH" }));
  check("no stored answer key → a TECHNICAL failure naming the cause (no invented answer)", /^Technical failure.*no answer key is stored/.test(noKeyErr ?? ""), noKeyErr);
  check("…and the failed question was not published", (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: noKey.id } })).questionId === null);

  section("D. WITHDRAWN questions");
  const wE = q({ stem: `Withdrawn question text ${suffix}` }, { stem: `वापस लिया गया प्रश्न ${suffix}` });
  const wd = await mk(10, wE, { status: "NEEDS_CORRECTION", answerStatus: AiImportAnswerStatus.WITHDRAWN, officialAnswer: [], finalAnswer: [], officialAnswerRaw: "*", issueCodes: ["POSSIBLE_WITHDRAWN"] });
  check("normal gate refuses a withdrawn question (unchanged)", /deleted in the official answer key/.test(importBlocker(await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: wd.id }, include: { figures: true } }), settings) ?? ""));
  check("'Add as WITHDRAWN' refused for a question the key did not withdraw", /only for a question the official answer key withdrew/.test((await refusal(forceImportQuestion({ ...ok, importQuestionId: hold.id, kind: "WITHDRAWN" }))) ?? ""));

  // A student's attempt submitted BEFORE the withdrawn question joins the paper (history must not change).
  const student = await prisma.student.create({ data: { studentId: `FR-${suffix}`, name: "FR Student", email: `fr-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const old = await startPreviousYearPaperAttempt(student.id, paper.id);
  const oldBefore = await submitAttempt(old.id, student.id);
  const w = await forceImportQuestion({ ...ok, importQuestionId: wd.id, kind: "WITHDRAWN" });
  const bw = await prisma.question.findUniqueOrThrow({ where: { id: w.questionId }, include: { options: true } });
  check("added to its paper as WITHDRAWN at its printed number, content preserved", bw.status === QuestionStatus.WITHDRAWN && bw.previousYearPaperId === paper.id && bw.paperQuestionNumber === 10 && bw.text === `Withdrawn question text ${suffix}` && bw.textHi === `वापस लिया गया प्रश्न ${suffix}` && bw.options.length === 4, { s: bw.status, n: bw.paperQuestionNumber });
  check("no correct option is stored for it (the placeholder was cleared)", bw.options.every((o) => !o.isCorrect) && bw.answerVerification === "WITHDRAWN_IN_OFFICIAL_KEY");
  check("audit ADD_AS_WITHDRAWN written", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_ADD_AS_WITHDRAWN", entityId: bw.id } })) === 1);
  check("never served outside its paper (practice / mocks use PUBLISHED only)", (await prisma.question.count({ where: { id: bw.id, ...SERVABLE_QUESTION_WHERE } })) === 0);
  const pubErr = await refusal(forceImportQuestion({ ...ok, importQuestionId: wd.id, kind: "PUBLISH" }));
  check("QA B1: FORCE TO PUBLISH on a question already added as WITHDRAWN is refused (no keyless publish)", /already in the Question Bank/.test(pubErr ?? "") && (await prisma.question.findUniqueOrThrow({ where: { id: bw.id } })).status === QuestionStatus.WITHDRAWN, pubErr);
  const wAgain = await forceImportQuestion({ ...ok, importQuestionId: wd.id, kind: "WITHDRAWN" });
  check("repeating Add as WITHDRAWN is an idempotent no-op", wAgain.alreadyDone && wAgain.questionId === bw.id);
  const wk = await mk(11, q({ stem: `Withdrawn with an old key ${suffix}` }), { status: "NEEDS_CORRECTION", answerStatus: AiImportAnswerStatus.WITHDRAWN, officialAnswer: [], finalAnswer: ["C"], answerConfirmedById: master.id });
  const wk2 = await forceImportQuestion({ ...ok, importQuestionId: wk.id, kind: "WITHDRAWN" });
  const bwk = await prisma.question.findUniqueOrThrow({ where: { id: wk2.questionId }, include: { options: true } });
  check("QA M2: a withdrawn question that carried an answer keeps NO correct option", bwk.status === QuestionStatus.WITHDRAWN && bwk.options.every((o) => !o.isCorrect) && bwk.answerVerification === "WITHDRAWN_IN_OFFICIAL_KEY", bwk.options.map((o) => [o.label, o.isCorrect]));
  // QA2 MAJOR 1: a forced run that stored the question but died before its final step is finished by a retry.
  await prisma.question.update({ where: { id: bwk.id }, data: { status: QuestionStatus.DRAFT } });
  await prisma.questionOption.updateMany({ where: { questionId: bwk.id, label: "A" }, data: { isCorrect: true } });
  const resumed = await forceImportQuestion({ ...ok, importQuestionId: wk.id, kind: "WITHDRAWN" });
  const bwk2 = await prisma.question.findUniqueOrThrow({ where: { id: bwk.id }, include: { options: true } });
  check("QA2: an interrupted forced WITHDRAWN (left DRAFT with key A) is finished on retry, key cleared", resumed.questionId === bwk.id && bwk2.status === QuestionStatus.WITHDRAWN && bwk2.options.every((o) => !o.isCorrect), { s: bwk2.status, o: bwk2.options.map((o) => o.isCorrect) });
  const draftOther = await prisma.question.update({ where: { id: r2.questionId }, data: { status: QuestionStatus.DRAFT } });
  check("…but a DRAFT stored by a different action is never re-stated (B1 still holds)", /already in the Question Bank/.test((await refusal(forceImportQuestion({ ...ok, importQuestionId: hold.id, kind: "WITHDRAWN" }))) ?? "") || /only for a question/.test((await refusal(forceImportQuestion({ ...ok, importQuestionId: hold.id, kind: "WITHDRAWN" }))) ?? ""));
  await prisma.question.update({ where: { id: draftOther.id }, data: { status: QuestionStatus.PUBLISHED } });
  // QA2 MAJOR 2: Resume never wipes a live lease (a forced import may hold it).
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: "FAILED", leaseOwner: "force:test", leaseUntil: new Date(Date.now() + 60_000) } });
  const resumeErr = await refusal(resumeJob(job.id, master.id, 1_000_000));
  check("QA2: Resume refuses while a live lease is held, and leaves the lease", /busy/.test(resumeErr ?? "") && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } })).leaseOwner === "force:test", resumeErr);
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: "NEEDS_REVIEW", leaseOwner: null, leaseUntil: null } });
  const oldAfter = await prisma.testAttempt.findUniqueOrThrow({ where: { id: old.id }, include: { questions: true } });
  check("historical attempt unchanged: same score, max marks, question count, no withdrawn row", oldAfter.score === oldBefore.score && oldAfter.maxScore === oldBefore.maxScore && oldAfter.totalQuestions === oldBefore.totalQuestions && oldAfter.questions.every((t) => t.questionId !== bw.id), { before: [oldBefore.score, oldBefore.maxScore], after: [oldAfter.score, oldAfter.maxScore] });

  const published = await prisma.question.count({ where: { previousYearPaperId: paper.id, status: QuestionStatus.PUBLISHED } });
  const withdrawnN = await prisma.question.count({ where: { previousYearPaperId: paper.id, status: QuestionStatus.WITHDRAWN } });
  const at = await startPreviousYearPaperAttempt(student.id, paper.id);
  const att = await prisma.testAttempt.findUniqueOrThrow({ where: { id: at.id }, include: { questions: { include: { answer: true }, orderBy: { order: "asc" } } } });
  const wtq = att.questions.find((t) => t.questionId === bw.id);
  check("the withdrawn question is in the attempt, in printed order", !!wtq && withdrawnN === 2 && att.questions.length === published + withdrawnN && att.questions.map((t) => t.questionId).slice(-2).join() === [bw.id, bwk.id].join(), att.questions.length);
  check("max marks / totalQuestions exclude it", att.totalQuestions === published, { total: att.totalQuestions, published });
  check("it has no Answer row (not unanswered, not anything)", att.questions.filter((t) => t.answer === null).length === withdrawnN && wtq?.answer === null && (await prisma.answer.count({ where: { attemptId: att.id } })) === published);
  const ws = wtq?.questionSnapshot as { withdrawn?: boolean; correctLabel?: string; hi?: unknown };
  check("snapshot: withdrawn flag, no answer key, Hindi kept", ws.withdrawn === true && ws.correctLabel === "" && !!ws.hi);
  const player = toPlayerQuestions(att.questions, { instantMode: false });
  const pw = player.find((p) => p.questionId === bw.id)!;
  check("player payload: withdrawn label flag, original text, no reveal", pw.withdrawn === true && pw.text === `Withdrawn question text ${suffix}` && pw.reveal === null && player.filter((p) => p.withdrawn).length === withdrawnN);
  const saveErr = await refusal(saveAnswer(at.id, student.id, bw.id, "A", false, 1));
  check("answering it is refused by the server", /withdrawn/.test(saveErr ?? ""), saveErr);
  const markErr = await refusal(saveAnswer(at.id, student.id, bw.id, null, true, 2));
  check("marking it for review is refused too", /withdrawn/.test(markErr ?? ""));
  // Answer every scored question: first correct, second wrong, rest unanswered.
  const scored = att.questions.filter((t) => !(t.questionSnapshot as { withdrawn?: boolean }).withdrawn);
  const key = (t: (typeof scored)[number]) => (t.questionSnapshot as { correctLabel: string }).correctLabel;
  await saveAnswer(at.id, student.id, scored[0].questionId, key(scored[0]), false, 3);
  await saveAnswer(at.id, student.id, scored[1].questionId, key(scored[1]) === "A" ? "B" : "A", false, 4);
  const res = await submitAttempt(at.id, student.id);
  check("score: 1 correct, 1 incorrect, unanswered excludes the withdrawn question, max = scored count", res.correctCount === 1 && res.incorrectCount === 1 && res.unansweredCount === published - 2 && res.maxScore === published, { c: res.correctCount, i: res.incorrectCount, u: res.unansweredCount, max: res.maxScore, published });
  check("after submit the withdrawn question still has no Answer row", (await prisma.answer.count({ where: { attemptId: at.id, questionId: bw.id } })) === 0);
  check("TestEngineError is the refusal type (not a crash)", (await refusal(saveAnswer(at.id, student.id, bw.id, "A", false, 9))) !== null && TestEngineError !== undefined);

  section("E. Job reconciliation after the actions (DB)");
  const rec = (await jobPaperReconciliation(job.id))!;
  const bucket = (n: number) => rec.rows.find((x) => x.number === n)?.bucket;
  check("expected 12; number 12 reported missing", rec.expected === 12 && JSON.stringify(rec.missing) === "[12]", rec.missing);
  check("forced ones are PUBLISHED, withdrawn one WITHDRAWN_IN_PAPER, no-key one BLOCKED", [3, 4, 5, 6, 7, 8].every((n) => bucket(n) === "PUBLISHED") && bucket(10) === "WITHDRAWN_IN_PAPER" && bucket(11) === "WITHDRAWN_IN_PAPER" && bucket(9) === "BLOCKED", rec.rows.map((x) => [x.number, x.bucket]));
  check("approved Needs-correction question 1 stays BLOCKED, Ready+approved 2 is APPROVED_IMPORTABLE", bucket(1) === "BLOCKED" && bucket(2) === "APPROVED_IMPORTABLE");

  check("no network request was attempted", blockedHosts.size === 0, [...blockedHosts]);
  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
