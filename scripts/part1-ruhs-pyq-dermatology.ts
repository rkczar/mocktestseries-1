/**
 * RUHS PYQ restoration — Part 1 (owner-approved, 2026-09-28).
 *
 *  1. VERIFY every RUHS Previous Year Paper: each linked question must have
 *     been created by a Question Bank import (never a Mock Test import) of a
 *     file whose Exam column names the RUHS exam. Report-only.
 *  2. RESET invalid IN_PROGRESS PYQ attempts: an attempt is invalid only
 *     when its frozen question set (TestAttemptQuestion) contains a question
 *     that is NOT a member of the attempt's paper. It is set ABANDONED (the
 *     existing schema status; resume only considers IN_PROGRESS, so the next
 *     Start creates a fresh attempt from the corrected paper). Snapshot rows
 *     and answers are kept untouched; SUBMITTED attempts are never selected.
 *     One AuditLog row per attempt: action PYQ_DATA_CORRECTION.
 *  3. DERMATOLOGY: the questions created by the RPSC Dermatology 2024 file
 *     (imported into DERMATOLOGY MOCK 1) are verified to be RUHS-exam,
 *     canonical Dermatology subject, topic == the file's own Topic column,
 *     no Previous Year Paper, source QUESTION_BANK. Confidently classified
 *     rows have the temporary review flag (set by the PYQ link repair)
 *     cleared; anything else stays flagged for review.
 *  4. SUBJECT MOCKS: a mock becomes a Subject Mock (coverage SUBJECT_WISE,
 *     one subject) only when ALL of its questions belong to one subject.
 *     Mixed / empty mocks are never classified.
 *  5. PART 2 report (Haryana/Punjab copies): counted, never modified.
 *
 * Never deletes anything. PII-free output (attempt ids only).
 *
 *   npx tsx scripts/part1-ruhs-pyq-dermatology.ts                      # dry run
 *   npx tsx scripts/part1-ruhs-pyq-dermatology.ts --apply --out <before.json>
 *   (either mode) --report-json <file>  writes the machine-readable report
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { AttemptStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const apply = process.argv.includes("--apply");
const argAfter = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
};
const outPath = argAfter("--out");
const reportJson = argAfter("--report-json");
const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const RUHS_CODE = "RUHSMO";
const DERMA_RUN_ID = "cmujwfrec00z6fykzpwg6iw0a"; // "DERMA AP RPSC" — RPSC_Dermatology_2024_FINAL.csv → DERMATOLOGY MOCK 1
const PART2_RUN_IDS = [
  "cmuioloef013beekzcvy7qeme", // HMO 24  → PYQ BASED RUHS MO MOCK TEST 03
  "cmul8f18v02q6h3kz1jirqgz3", // Punjab 2024 → PYQ BASED RUHS MO MOCK TEST 06
  "cmuiockfz00g9cbkz09s16t75", // HMO 22  → PYQ BASED RUHS MO MOCK TEST 02
  "cmul8i42t01rmclkzgxg1zrzf", // Punjab 2015 → PYQ BASED RUHS MO MOCK TEST 07
  "cmuin1lm9006unrkzetlvmlhw", // HMO 2020 → PYQ BASED RUHS MO MOCK TEST 1
];

async function main() {
  if (apply && !outPath) throw new Error("--apply requires --out <before-state.json>");
  const report: Record<string, unknown> = { mode: apply ? "APPLY" : "DRY_RUN", at: new Date().toISOString() };
  const ruhs = await prisma.exam.findUniqueOrThrow({ where: { code: RUHS_CODE }, select: { id: true, name: true, code: true } });

  // 1. Papers ------------------------------------------------------------
  const papers = await prisma.previousYearPaper.findMany({ where: { examId: ruhs.id }, orderBy: { year: "desc" }, select: { id: true, year: true, title: true, isActive: true } });
  const paperRows = [];
  for (const p of papers) {
    const qs = await prisma.question.findMany({
      where: { previousYearPaperId: p.id },
      select: { id: true, code: true, status: true, examId: true, examYear: true, importBatchId: true, importBatch: { select: { filename: true, mockTestId: true } } },
    });
    const rows = await prisma.bulkImportRow.findMany({ where: { questionId: { in: qs.map((q) => q.id) }, status: "SUCCESS" }, select: { questionId: true, runId: true, rawData: true } });
    const rowFor = new Map(rows.map((r) => [`${r.runId}:${r.questionId}`, r]));
    const suspicious = qs.filter((q) => {
      if (q.examId !== ruhs.id || q.examYear !== p.year) return true;
      if (!q.importBatchId) return false; // manually authored into the paper — explicit
      if (q.importBatch?.mockTestId) return true;
      const raw = (rowFor.get(`${q.importBatchId}:${q.id}`)?.rawData ?? {}) as Record<string, unknown>;
      const fileExam = typeof raw.exam === "string" ? raw.exam : "";
      return Boolean(fileExam) && norm(fileExam) !== norm(ruhs.code) && norm(fileExam) !== norm(ruhs.name);
    });
    const sorted = qs.map((q) => q.code).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    paperRows.push({
      id: p.id,
      year: p.year,
      title: p.title,
      isActive: p.isActive,
      linked: qs.length,
      published: qs.filter((q) => q.status === "PUBLISHED").length,
      draft: qs.filter((q) => q.status === "DRAFT").length,
      archived: qs.filter((q) => q.status === "ARCHIVED").length,
      suspicious: suspicious.length,
      codeRange: sorted.length ? `${sorted[0]} … ${sorted[sorted.length - 1]}` : "—",
      provenance: [...new Set(qs.map((q) => q.importBatch?.filename ?? "manual"))],
    });
  }
  report.papers = paperRows;
  console.log(`Mode: ${report.mode}\n\n1. RUHS Previous Year Papers`);
  for (const r of paperRows)
    console.log(`  ${r.year}  linked ${r.linked}  published ${r.published}  draft ${r.draft}  archived ${r.archived}  suspicious ${r.suspicious}  ${r.codeRange}  [${r.provenance.join(", ")}]`);

  // 2. Invalid IN_PROGRESS PYQ attempts ----------------------------------
  const pyqAttempts = await prisma.testAttempt.findMany({
    where: { previousYearPaperId: { not: null } },
    select: {
      id: true,
      status: true,
      previousYearPaperId: true,
      startedAt: true,
      previousYearPaper: { select: { title: true } },
      // TestAttemptQuestion is snapshot-only (no Question relation by design).
      questions: { select: { questionId: true } },
    },
  });
  const frozenIds = [...new Set(pyqAttempts.flatMap((a) => a.questions.map((q) => q.questionId)))];
  const paperOf = new Map(
    (await prisma.question.findMany({ where: { id: { in: frozenIds } }, select: { id: true, previousYearPaperId: true } })).map((q) => [q.id, q.previousYearPaperId])
  );
  const invalid = pyqAttempts
    .map((a) => ({ ...a, foreign: a.questions.filter((q) => paperOf.get(q.questionId) !== a.previousYearPaperId).length }))
    .filter((a) => a.foreign > 0);
  const invalidInProgress = invalid.filter((a) => a.status === AttemptStatus.IN_PROGRESS);
  const answeredBy = new Map(
    (
      await prisma.answer.groupBy({
        by: ["attemptId"],
        where: { attemptId: { in: invalidInProgress.map((a) => a.id) }, selectedOptionLabel: { not: null } },
        _count: { _all: true },
      })
    ).map((g) => [g.attemptId, g._count._all])
  );
  report.attempts = {
    pyqAttemptsScanned: pyqAttempts.length,
    invalidFound: invalid.length,
    invalidSubmitted: invalid.filter((a) => a.status === AttemptStatus.SUBMITTED).length,
    invalidAlreadyAbandoned: invalid.filter((a) => a.status === AttemptStatus.ABANDONED).length,
    invalidInProgress: invalidInProgress.map((a) => ({
      attemptId: a.id,
      paper: a.previousYearPaper?.title,
      startedAt: a.startedAt.toISOString(),
      frozenQuestions: a.questions.length,
      foreignQuestions: a.foreign,
      answered: answeredBy.get(a.id) ?? 0,
    })),
  };
  console.log(
    `\n2. PYQ attempts scanned ${pyqAttempts.length}; invalid ${invalid.length} (IN_PROGRESS ${invalidInProgress.length}, SUBMITTED ${
      invalid.filter((a) => a.status === "SUBMITTED").length
    }, ABANDONED ${invalid.filter((a) => a.status === "ABANDONED").length})`
  );
  for (const a of invalidInProgress)
    console.log(`  ${a.id}  ${a.previousYearPaper?.title}  frozen ${a.questions.length}  foreign ${a.foreign}  answered ${answeredBy.get(a.id) ?? 0}`);

  // 3. Dermatology 150 ------------------------------------------------------
  const derma = await prisma.subject.findMany({ where: { nameKey: "dermatology" }, select: { id: true, name: true } });
  if (derma.length !== 1) throw new Error(`Expected exactly one canonical Dermatology subject, found ${derma.length}`);
  const dermaSubject = derma[0];
  const dermaRows = await prisma.bulkImportRow.findMany({
    where: { runId: DERMA_RUN_ID, status: "SUCCESS", questionId: { not: null } },
    select: { questionId: true, rawData: true },
  });
  const dermaQs = await prisma.question.findMany({
    where: { id: { in: dermaRows.map((r) => r.questionId!) }, importBatchId: DERMA_RUN_ID },
    select: {
      id: true,
      code: true,
      examId: true,
      subjectId: true,
      topicId: true,
      previousYearPaperId: true,
      source: true,
      status: true,
      reviewRequired: true,
      reviewReason: true,
      topic: { select: { name: true, subjectId: true } },
    },
  });
  const rawFor = new Map(dermaRows.map((r) => [r.questionId!, r.rawData as Record<string, unknown>]));
  const isConfident = (q: (typeof dermaQs)[number]) => {
    const raw = rawFor.get(q.id) ?? {};
    return (
      q.examId === ruhs.id &&
      q.subjectId === dermaSubject.id &&
      q.previousYearPaperId === null &&
      q.source === "QUESTION_BANK" &&
      q.topic !== null &&
      q.topic.subjectId === dermaSubject.id &&
      norm(String(raw.topic ?? "")) === norm(q.topic.name) &&
      norm(String(raw.subject ?? "")) === norm(dermaSubject.name)
    );
  };
  const confident = dermaQs.filter(isConfident);
  const needsReview = dermaQs.filter((q) => !isConfident(q));
  const byTopic: Record<string, number> = {};
  for (const q of dermaQs) byTopic[q.topic?.name ?? "(no topic)"] = (byTopic[q.topic?.name ?? "(no topic)"] ?? 0) + 1;
  report.dermatology = {
    subject: dermaSubject,
    found: dermaQs.length,
    confident: confident.length,
    reviewRequired: needsReview.map((q) => q.code),
    published: dermaQs.filter((q) => q.status === "PUBLISHED").length,
    withPaperLink: dermaQs.filter((q) => q.previousYearPaperId).length,
    stillFlaggedFromRepair: dermaQs.filter((q) => q.reviewRequired).length,
    byTopic,
  };
  console.log(
    `\n3. Dermatology: found ${dermaQs.length}; confident ${confident.length}; review ${needsReview.length}; paper links ${dermaQs.filter((q) => q.previousYearPaperId).length}`
  );
  for (const [t, n] of Object.entries(byTopic)) console.log(`  ${n.toString().padStart(3)}  ${t}`);

  // 4. Subject mocks ---------------------------------------------------------
  const mocks = await prisma.mockTest.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      coverageType: true,
      coverageSubjectIds: true,
      questions: { select: { question: { select: { subjectId: true } } } },
      _count: { select: { testAttempts: true } },
    },
  });
  const subjectMocks = mocks
    .map((m) => ({ ...m, subjects: [...new Set(m.questions.map((q) => q.question.subjectId))] }))
    .filter((m) => m.questions.length > 0 && m.subjects.length === 1);
  const subjectNames = new Map(
    (await prisma.subject.findMany({ where: { id: { in: subjectMocks.map((m) => m.subjects[0]) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name])
  );
  const alreadyClassified = (m: (typeof subjectMocks)[number]) =>
    m.coverageType === "SUBJECT_WISE" && m.coverageSubjectIds.length === 1 && m.coverageSubjectIds[0] === m.subjects[0];
  const toClassify = subjectMocks.filter((m) => !alreadyClassified(m));
  report.subjectMocks = subjectMocks.map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    subject: subjectNames.get(m.subjects[0]),
    questions: m.questions.length,
    attempts: m._count.testAttempts,
    before: `${m.coverageType} ${JSON.stringify(m.coverageSubjectIds)}`,
    change: alreadyClassified(m) ? "already Subject Mock" : "→ SUBJECT_WISE",
  }));
  console.log(`\n4. Single-subject mocks: ${subjectMocks.length}; to classify ${toClassify.length}`);
  for (const m of subjectMocks)
    console.log(
      `  ${m.title}  (${subjectNames.get(m.subjects[0])}, ${m.questions.length} Qs, ${m._count.testAttempts} attempts)  ${m.coverageType}${alreadyClassified(m) ? "" : " → SUBJECT_WISE"}`
    );

  // 5. Part 2 (report only) ------------------------------------------------
  const part2 = await prisma.question.findMany({
    where: { importBatchId: { in: PART2_RUN_IDS } },
    select: {
      id: true,
      status: true,
      previousYearPaperId: true,
      importBatch: { select: { label: true } },
      _count: { select: { mockTestQuestions: true, customModuleQuestions: true } },
    },
  });
  const inAttempts = await prisma.testAttemptQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: part2.map((q) => q.id) } } });
  const part2By: Record<string, number> = {};
  for (const q of part2) part2By[q.importBatch?.label ?? "?"] = (part2By[q.importBatch?.label ?? "?"] ?? 0) + 1;
  report.part2 = {
    total: part2.length,
    byRun: part2By,
    published: part2.filter((q) => q.status === "PUBLISHED").length,
    archived: part2.filter((q) => q.status === "ARCHIVED").length,
    withPaperLink: part2.filter((q) => q.previousYearPaperId).length,
    inMocks: part2.filter((q) => q._count.mockTestQuestions > 0).length,
    inCustomModules: part2.filter((q) => q._count.customModuleQuestions > 0).length,
    inAttemptSnapshots: inAttempts.length,
  };
  console.log(`\n5. Part 2 pending duplicates (NOT modified): ${JSON.stringify(report.part2)}`);

  if (reportJson) writeFileSync(reportJson, JSON.stringify(report, null, 2));
  if (!apply) return;

  writeFileSync(
    outPath!,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        attempts: invalidInProgress.map((a) => ({ id: a.id, status: a.status, previousYearPaperId: a.previousYearPaperId })),
        dermatologyQuestions: confident.map((q) => ({ id: q.id, code: q.code, reviewRequired: q.reviewRequired, reviewReason: q.reviewReason })),
        mocks: toClassify.map((m) => ({ id: m.id, title: m.title, coverageType: m.coverageType, coverageSubjectIds: m.coverageSubjectIds })),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  await prisma.$transaction(
    async (tx) => {
      for (const a of invalidInProgress) {
        // Guarded: only flips a row that is still IN_PROGRESS right now.
        const res = await tx.testAttempt.updateMany({ where: { id: a.id, status: AttemptStatus.IN_PROGRESS }, data: { status: AttemptStatus.ABANDONED } });
        if (res.count !== 1) throw new Error(`Attempt ${a.id} changed state concurrently — aborting, nothing written.`);
        await tx.auditLog.create({
          data: {
            action: "PYQ_DATA_CORRECTION",
            entityType: "TestAttempt",
            entityId: a.id,
            metadata: {
              reason:
                "Attempt was frozen from an inflated PYQ paper (other-exam / mock-only questions wrongly linked). Reset so the student restarts on the corrected paper.",
              paper: a.previousYearPaper?.title ?? null,
              previousStatus: "IN_PROGRESS",
              newStatus: "ABANDONED",
              frozenQuestions: a.questions.length,
              foreignQuestions: a.foreign,
              answeredKept: answeredBy.get(a.id) ?? 0,
              snapshotAndAnswers: "preserved unchanged",
            },
          },
        });
      }
      if (confident.length) {
        await tx.question.updateMany({ where: { id: { in: confident.map((q) => q.id) } }, data: { reviewRequired: false, reviewReason: null } });
      }
      for (const m of toClassify) {
        await tx.mockTest.update({ where: { id: m.id }, data: { coverageType: "SUBJECT_WISE", coverageSubjectIds: [m.subjects[0]], coverageTopicIds: [] } });
      }
      await tx.auditLog.create({
        data: {
          action: "RUHS_PYQ_DERMATOLOGY_PART1",
          entityType: "Question",
          metadata: {
            beforeStateFile: outPath,
            attemptsReset: invalidInProgress.length,
            dermatologyConfirmed: confident.length,
            dermatologyReview: needsReview.length,
            subjectMocksClassified: toClassify.map((m) => m.title),
          },
        },
      });
    },
    { timeout: 120_000 }
  );
  console.log(`\nAPPLIED. Before-state: ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
