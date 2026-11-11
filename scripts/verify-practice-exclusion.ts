/**
 * Per-question practice exclusion (Question.excludeFromPractice, 2026-11-11) — scratch database only, no network.
 * Historical current-affairs PYQs are kept out of AUTOMATICALLY generated practice and stay in everything an admin or
 * the paper itself includes explicitly:
 *   A. Subject Test, Topic Test, Test on the Go (same engine), a student's filtered Custom Module, pool counts — never
 *   B. own Previous Year Paper, curated Mock Test, admin-curated Custom Module — always (explicit inclusion kept)
 *   C. server-side: the selection service itself filters (not the UI); a whole-pool draw never contains one
 *   D. admin form parsing; import staging: academic-review hold and practice flag carried on import; deleted guard
 *   E. an exam with no excluded question behaves exactly as before (English-only regression)
 *
 *   DATABASE_URL=<scratch mts_*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-practice-exclusion.ts
 */
import "dotenv/config";
import { AiImportAnswerStatus, AiImportQuestionStatus, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider, type AiImportFigure, type AiImportQuestion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { startCustomModuleAttempt, startMockTestAttempt, startPreviousYearPaperAttempt, startSubjectTestAttempt } from "@/lib/test-attempt";
import { countPublishedQuestions, distinctYears, publishedQuestionIds, selectPublishedQuestions } from "@/lib/question-selection";
import { getExamSubjectsOverview } from "@/lib/student-data";
import { parseQuestionForm } from "@/lib/question-form-core";
import { importBlocker } from "@/lib/ai-import/adapter";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
globalThis.fetch = (async () => {
  throw new Error("test network guard: no network in this suite");
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `PX Exam ${suffix}`, code: `PX-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const gk = await createFixtureSubject(prisma, { examId: exam.id, name: "Current Events and Issues of Rajasthan and India" });
  const ca = await createFixtureTopic(prisma, { subjectId: gk.id, name: "National and international events" });
  const paper2019 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2019, title: `PX FSO 2019 ${suffix}` } });
  let n = 0;
  const mk = (extra: { excluded?: boolean; pyq?: boolean; year?: number }) =>
    prisma.question.create({
      data: {
        examId: exam.id, subjectId: gk.id, topicId: ca.id, code: `PX-${suffix}-${++n}`, text: `PX question ${n}?`, status: QuestionStatus.PUBLISHED, difficulty: QuestionDifficulty.MEDIUM,
        examYear: extra.year ?? 2019,
        ...(extra.pyq ? { previousYearPaperId: paper2019.id, source: QuestionSource.PYQ, paperQuestionNumber: n } : {}),
        ...(extra.excluded ? { excludeFromPractice: true, excludeFromPracticeReason: "Historical current affairs (FSO 2019 paper)" } : {}),
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label.toLowerCase(), isCorrect: label === "B", order })) },
      },
    });
  // 6 historical current-affairs PYQs (excluded) + 4 ordinary bank questions in the same topic.
  const excluded = [];
  for (let k = 0; k < 6; k++) excluded.push(await mk({ excluded: true, pyq: true }));
  const normal = [];
  for (let k = 0; k < 4; k++) normal.push(await mk({ year: 2024 }));
  const excludedIds = new Set(excluded.map((q) => q.id));
  const mkStudent = async (tag: string) => (await prisma.student.create({ data: { studentId: `PX${tag}-${suffix}`, name: `PX ${tag}`, email: `px-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } })).id;
  const idsOf = async (attemptId: string) => (await prisma.testAttemptQuestion.findMany({ where: { attemptId }, select: { questionId: true } })).map((r) => r.questionId);

  section("A. Automatically generated practice never draws an excluded question");
  {
    const a = await startSubjectTestAttempt(await mkStudent("st"), { examId: exam.id, subjectId: gk.id, count: 50, durationMinutes: 0, minutesPerQuestion: 1 });
    const ids = await idsOf(a.id);
    check("Subject Test (whole subject, 50 asked): only the 4 practice questions, none excluded", ids.length === 4 && ids.every((id) => !excludedIds.has(id)), { n: ids.length });
  }
  {
    const a = await startSubjectTestAttempt(await mkStudent("tt"), { examId: exam.id, subjectId: gk.id, topicId: ca.id, count: 50, durationMinutes: 0, minutesPerQuestion: 1 });
    const ids = await idsOf(a.id);
    check("Topic Test (subject + topic): none excluded", ids.length === 4 && ids.every((id) => !excludedIds.has(id)), { n: ids.length });
  }
  {
    const a = await startSubjectTestAttempt(await mkStudent("og"), { examId: exam.id, subjectId: gk.id, count: 3, durationMinutes: 3, minutesPerQuestion: 1 });
    const ids = await idsOf(a.id);
    check("Test on the Go / random practice (same engine, 3 random): none excluded", ids.length === 3 && ids.every((id) => !excludedIds.has(id)), { n: ids.length });
  }
  {
    const a = await startSubjectTestAttempt(await mkStudent("py"), { examId: exam.id, subjectId: gk.id, source: QuestionSource.PYQ, year: 2019, count: 50, durationMinutes: 0, minutesPerQuestion: 1 }).catch((e: Error) => e);
    check("Subject Test filtered to PYQ 2019 (only excluded questions match): nothing drawn — never a fallback to excluded ones", a instanceof Error, a instanceof Error ? a.message : "started");
  }
  {
    let leaked = 0;
    for (let k = 0; k < 25; k++) {
      const { questions } = await selectPublishedQuestions({ examId: exam.id, subjectId: gk.id, count: 10, allowFewer: true });
      leaked += questions.filter((q) => excludedIds.has(q.id)).length;
    }
    check("student-built (filtered) Custom Module draw — 25 whole-pool draws: 0 excluded questions", leaked === 0, leaked);
  }
  check("practice pool count = 4 (excluded not counted)", (await countPublishedQuestions({ examId: exam.id, subjectId: gk.id })) === 4);
  check("year list for practice offers 2024 only (2019 has only excluded questions)", JSON.stringify(await distinctYears({ examId: exam.id, subjectId: gk.id })) === "[2024]", await distinctYears({ examId: exam.id, subjectId: gk.id }));
  check("Test on the Go subject picker count = 4", (await getExamSubjectsOverview(exam.id)).find((s) => s.id === gk.id)?.questionCount === 4);

  section("B. Explicit inclusion is kept (no silent override)");
  {
    const a = await startPreviousYearPaperAttempt(await mkStudent("pp"), paper2019.id);
    const ids = await idsOf(a.id);
    check("its own Previous Year Paper serves all 6 excluded questions (historical PYQ access)", ids.length === 6 && ids.every((id) => excludedIds.has(id)), { n: ids.length });
  }
  {
    const mock = await prisma.mockTest.create({ data: { examId: exam.id, title: `PX curated mock ${suffix}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: [...excluded.slice(0, 2), ...normal.slice(0, 2)].map((q, order) => ({ questionId: q.id, order })) } } });
    const ids = await idsOf((await startMockTestAttempt(await mkStudent("mk"), mock.id)).id);
    check("curated Mock Test with 2 excluded + 2 normal: all 4 served (admin's choice kept)", ids.length === 4 && excluded.slice(0, 2).every((q) => ids.includes(q.id)), { n: ids.length });
  }
  {
    const chosen = await publishedQuestionIds([excluded[2].id, normal[2].id]);
    check("admin Custom Module hand-pick accepts an excluded (published) question", chosen.length === 2);
    const sid = await mkStudent("cm");
    const mod = await prisma.customModule.create({ data: { examId: exam.id, title: "PX admin module", selectionMode: "RULE_BASED", status: "ACTIVE", accessType: "FREE", isStudentOwned: false, createdByStudentId: null, durationMode: "UNLIMITED", answerMode: "EXAM", questions: { create: chosen.map((questionId, order) => ({ questionId, order })) } } });
    const ids = await idsOf((await startCustomModuleAttempt(sid, mod.id)).id);
    check("admin-curated Custom Module serves the excluded question it lists", ids.includes(excluded[2].id) && ids.length === 2, { n: ids.length });
  }
  {
    const q = await prisma.question.findUniqueOrThrow({ where: { id: excluded[0].id } });
    check("an excluded question keeps its exam year, paper reference and source", q.examYear === 2019 && q.previousYearPaperId === paper2019.id && q.source === QuestionSource.PYQ && q.status === QuestionStatus.PUBLISHED);
  }

  section("C. Server-side enforcement");
  {
    const directly = await prisma.question.count({ where: { examId: exam.id, status: QuestionStatus.PUBLISHED } });
    const viaService = await countPublishedQuestions({ examId: exam.id });
    check(`the filter lives in the selection service: ${directly} published, ${viaService} in the practice pool, whatever the client sends`, directly === 10 && viaService === 4);
    const crafted = await selectPublishedQuestions({ examId: exam.id, subjectId: gk.id, topicId: ca.id, source: QuestionSource.PYQ, year: 2019, count: 1, allowFewer: true }).catch((e: Error) => e);
    check("a crafted request naming exactly the excluded questions' filters gets none of them", crafted instanceof Error || crafted.questions.length === 0, crafted instanceof Error ? crafted.message : crafted.questions.length);
  }

  section("D. Admin form, import staging, deleted and pending protections");
  {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ examId: exam.id, subjectId: gk.id, text: "Form question?", difficulty: "MEDIUM", status: "DRAFT", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: "B", excludeFromPractice: "on", excludeFromPracticeReason: "Historical current affairs" })) fd.set(k, v);
    const parsed = parseQuestionForm(fd);
    check("admin form carries the practice exclusion and its reason", parsed.success && parsed.data.excludeFromPractice === "on" && parsed.data.excludeFromPracticeReason === "Historical current affairs", parsed.success ? parsed.data.excludeFromPractice : parsed.error.issues);
  }
  const settings = normalizeImporterSettings({});
  const base = { questionId: null, status: AiImportQuestionStatus.READY, issueCodes: [], finalAnswer: ["B"], answerConfirmedById: "admin", answerStatus: AiImportAnswerStatus.OFFICIAL_MATCHED, officialAnswer: ["B"], subjectId: gk.id, questionType: "SINGLE_CORRECT", approvedById: "admin", allowDuplicate: false, figures: [] as AiImportFigure[], academicReview: null, excludeFromPractice: false, data: { stem: "x", options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: `(${l})`, text: l })), number: 1, type: "SINGLE_CORRECT" }, editedData: null } as unknown as AiImportQuestion & { figures: AiImportFigure[] };
  check("import gate: ambiguous taxonomy pending → never imported", /taxonomy pending academic review \(AMBIGUOUS_PENDING_ACADEMIC_REVIEW\)/.test(importBlocker({ ...base, academicReview: "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" }, settings) ?? ""));
  check("import gate: unmapped pending (2019 Q90 case) → never imported, even with a subject and an approval", /UNMAPPED_PENDING_ACADEMIC_REVIEW/.test(importBlocker({ ...base, academicReview: "UNMAPPED_PENDING_ACADEMIC_REVIEW" }, settings) ?? ""));
  check("import gate: deleted in the official key → never imported, even with an answer set (5d86153 kept)", /deleted in the official answer key/.test(importBlocker({ ...base, answerStatus: AiImportAnswerStatus.WITHDRAWN }, settings) ?? ""));
  check("import gate: a historical current-affairs question marked for exclusion is still importable (only practice changes)", importBlocker({ ...base, excludeFromPractice: true }, settings) === null, importBlocker({ ...base, excludeFromPractice: true }, settings));

  section("E. English-only exam unaffected");
  {
    const en = await prisma.exam.create({ data: { name: `PX EN ${suffix}`, code: `PXEN-${suffix}`, isActive: true } });
    const s = await createFixtureSubject(prisma, { examId: en.id, name: "PX EN Subject" });
    for (let k = 0; k < 5; k++) await prisma.question.create({ data: { examId: en.id, subjectId: s.id, code: `PXEN-${suffix}-${k}`, text: `EN ${k}?`, status: QuestionStatus.PUBLISHED, difficulty: QuestionDifficulty.EASY, options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label, isCorrect: label === "A", order })) } } });
    const fresh = await prisma.question.findMany({ where: { examId: en.id }, select: { excludeFromPractice: true } });
    check("a question created without the flag defaults to in-practice (existing rows: column default false)", fresh.every((q) => q.excludeFromPractice === false));
    const a = await startSubjectTestAttempt(await mkStudent("en"), { examId: en.id, subjectId: s.id, count: 5, durationMinutes: 0, minutesPerQuestion: 1 });
    check("English-only exam Subject Test draws all 5 as before", (await idsOf(a.id)).length === 5);
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
