/**
 * Targeted verification for the Question Bank upgrade (Template Builder,
 * bulk-import staging/validation workspace, image management, RBAC).
 * Follows the same pattern as scripts/verify-syllabus.ts: exercises the
 * underlying lib/*.ts functions directly against the real (shared) DB with
 * fixture rows cleaned up at the end, since the mutation server actions are
 * "use server" files that can't be imported into a plain script.
 *
 * Run from the repo root:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-questionbank-upgrade.ts
 */
import "dotenv/config";
import { PrismaClient, BulkImportDuplicateStrategy, RoleName } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport, recomputeRunCounts } from "@/lib/bulk-import-execute";
import { validateSelection, REQUIRED_CORE_KEYS, PRESETS } from "../app/admin/(dashboard)/questions/templates/presets";
import { readFileSync } from "fs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}`);
  if (!condition) failures++;
}

function baseRow(overrides: Partial<BulkImportRow> = {}): BulkImportRow {
  return {
    rowNumber: 1,
    exam: "VERIFY-QB-EXAM",
    examYear: "2026",
    subject: "VERIFY-QB-SUBJECT",
    topic: "",
    subTopic: "",
    source: "",
    questionText: "What is 2 + 2?",
    optionA: "3",
    optionB: "4",
    optionC: "5",
    optionD: "6",
    correctAnswer: "B",
    difficulty: "EASY",
    status: "",
    ...overrides,
  };
}

async function main() {
  const createdIds: { exams: string[]; runs: string[]; questions: string[] } = { exams: [], runs: [], questions: [] };

  try {
    // ---- 1. RBAC permission matrix ------------------------------------------
    console.log("\n--- RBAC ---");
    check("FULL_ADMIN role exists (renamed from ADMIN)", "FULL_ADMIN" in DEFAULT_ROLE_PERMISSIONS);
    check(
      "FULL_ADMIN does NOT have QUESTIONS_MANAGE (global read-only on Question Bank)",
      !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.QUESTIONS_MANAGE)
    );
    check(
      "FULL_ADMIN keeps every OTHER manage permission it had before (not a blanket lockout)",
      [
        PERMISSIONS.WEBSITE_MANAGE,
        PERMISSIONS.EXAMS_MANAGE,
        PERMISSIONS.TESTS_MANAGE,
        PERMISSIONS.STUDENTS_MANAGE,
        PERMISSIONS.ANNOUNCEMENTS_MANAGE,
        PERMISSIONS.COMMUNICATIONS_MANAGE,
      ].every((p) => DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(p))
    );
    check("MASTER_ADMIN has QUESTIONS_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.QUESTIONS_MANAGE));
    check("TEACHER still has QUESTIONS_MANAGE (unaffected by the FULL_ADMIN change)", DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.QUESTIONS_MANAGE));
    check("RoleName.FULL_ADMIN exists on the Prisma enum (schema rename applied)", "FULL_ADMIN" in RoleName);

    const mutationRoutes = [
      "app/api/admin/questions/bulk-import/upload/route.ts",
      "app/api/admin/questions/bulk-import/validate/route.ts",
      "app/api/admin/questions/bulk-import/import/route.ts",
      "app/api/admin/questions/bulk-import/rows/[rowId]/route.ts",
      "app/api/admin/questions/bulk-import/runs/[runId]/bulk-actions/route.ts",
      "app/api/admin/questions/images/route.ts",
      "app/api/admin/questions/bulk-actions/route.ts",
    ];
    for (const route of mutationRoutes) {
      const src = readFileSync(route, "utf-8");
      check(`${route} calls requirePermission(PERMISSIONS.QUESTIONS_MANAGE)`, /requirePermission\(\s*PERMISSIONS\.QUESTIONS_MANAGE\s*\)/.test(src));
    }

    // ---- 2. Row-shape validation severities (no DB) -------------------------
    console.log("\n--- Validation severities ---");
    const [validRow] = validateImportRows([baseRow({ topic: "Some Topic", subTopic: "Some SubTopic", source: "QUESTION_BANK", status: "DRAFT" })]);
    check("A fully-populated row (incl. optional metadata) is VALID", validRow.severity === "VALID" && validRow.isValid);

    const [warningRow] = validateImportRows([baseRow()]);
    check("Leaving optional metadata (Topic/SubTopic/Source) blank is a WARNING, not VALID or ERROR", warningRow.severity === "WARNING" && warningRow.isValid);

    const [missingTextRow] = validateImportRows([baseRow({ questionText: "" })]);
    check("Missing Question Text is an ERROR (blocks import)", missingTextRow.severity === "ERROR" && !missingTextRow.isValid);

    const [missingTopicRow] = validateImportRows([baseRow({ topic: "" })]);
    check(
      "Missing Topic is only a WARNING, not an ERROR (Topic is optional on Question) — row still importable",
      missingTopicRow.severity === "WARNING" && missingTopicRow.isValid
    );

    const [badAnswerRow] = validateImportRows([baseRow({ correctAnswer: "Z" })]);
    check("An invalid Correct Answer value is an ERROR", badAnswerRow.severity === "ERROR");

    // ---- 3. Template Builder preset requiredness (no DB) --------------------
    console.log("\n--- Template Builder ---");
    check(
      "REQUIRED_CORE_KEYS matches the validator's true always-required fields (no Topic/SubTopic/Source)",
      !(REQUIRED_CORE_KEYS as readonly string[]).includes("topic") &&
        !(REQUIRED_CORE_KEYS as readonly string[]).includes("subTopic") &&
        !(REQUIRED_CORE_KEYS as readonly string[]).includes("source")
    );
    check("A selection missing a required column is rejected", !validateSelection(["exam"]).ok);
    check("A selection containing every required column is accepted", validateSelection([...REQUIRED_CORE_KEYS]).ok);
    for (const presetId of Object.keys(PRESETS)) {
      const preset = PRESETS[presetId as keyof typeof PRESETS];
      check(`Preset ${presetId} defaultChecked + required-core columns round-trip the importer`, validateSelection([...REQUIRED_CORE_KEYS, ...preset.defaultChecked]).ok);
    }

    // ---- 4. Full staging -> validate -> execute cycle against the real DB ---
    console.log("\n--- Bulk import execution (fixture data, cleaned up after) ---");
    const suffix = Date.now();
    const exam = await prisma.exam.create({ data: { name: `VERIFY-QB-EXAM-${suffix}`, code: `VERIFYQB${suffix}` } });
    createdIds.exams.push(exam.id);
    const subject = await prisma.subject.create({ data: { examId: exam.id, name: "VERIFY-QB-SUBJECT" } });

    const adminUser = await prisma.adminUser.findFirst({ where: { role: { name: RoleName.MASTER_ADMIN } } });
    if (!adminUser) throw new Error("No MASTER_ADMIN admin user found to attribute the fixture import to");

    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: adminUser.id,
        filename: "verify-fixture.csv",
        totalRows: 2,
        duplicateStrategy: BulkImportDuplicateStrategy.SKIP,
        examId: exam.id,
        examYear: 2026,
        label: `VERIFY-QB fixture ${suffix}`,
      },
    });
    createdIds.runs.push(run.id);

    const validFixture = baseRow({ exam: exam.name, subject: subject.name, questionText: `Fixture valid question ${suffix}` });
    const errorFixture = baseRow({ exam: exam.name, subject: subject.name, questionText: "" });

    await prisma.bulkImportRow.createMany({
      data: [
        { runId: run.id, rowNumber: 1, rawData: validFixture as object },
        { runId: run.id, rowNumber: 2, rawData: errorFixture as object },
      ],
    });

    const result = await executeBulkImport({ runId: run.id, adminUserId: adminUser.id });
    check("Partial import: 1 success + 1 failure, run does not abort entirely", result.successCount === 1 && result.failedCount === 1);
    check("Import status is PARTIALLY_IMPORTED when some rows fail", result.status === "PARTIALLY_IMPORTED");

    const createdQuestion = await prisma.question.findFirst({ where: { text: validFixture.questionText } });
    check("Valid row created a real Question", !!createdQuestion);
    if (createdQuestion) {
      createdIds.questions.push(createdQuestion.id);
      check("Created Question.importBatchId points back to this run (Import Batch filter data)", createdQuestion.importBatchId === run.id);
    }

    const failedRow = await prisma.bulkImportRow.findFirst({ where: { runId: run.id, rowNumber: 2 } });
    check("The error row is marked FAILED, not silently dropped or deleted", failedRow?.status === "FAILED");
    check("The error row was never removedFromImport (still visible/manageable, not discarded)", failedRow?.removedFromImport === false);

    await recomputeRunCounts(run.id);
    const refreshedRun = await prisma.bulkImportRun.findUnique({ where: { id: run.id } });
    check("recomputeRunCounts reflects 1 valid row remaining (the failed one stays ERROR)", refreshedRun?.invalidRows === 1);

    // ---- 5. Duplicate handling: re-importing the same row with SKIP --------
    const dupRun = await prisma.bulkImportRun.create({
      data: {
        adminUserId: adminUser.id,
        filename: "verify-fixture-dup.csv",
        totalRows: 1,
        duplicateStrategy: BulkImportDuplicateStrategy.SKIP,
      },
    });
    createdIds.runs.push(dupRun.id);
    await prisma.bulkImportRow.create({ data: { runId: dupRun.id, rowNumber: 1, rawData: validFixture as object } });
    const dupResult = await executeBulkImport({ runId: dupRun.id, adminUserId: adminUser.id });
    check("Re-importing an identical row with duplicateStrategy=SKIP skips it rather than erroring or duplicating", dupResult.skippedCount === 1 && dupResult.successCount === 0);

    const questionCountAfterDup = await prisma.question.count({ where: { text: validFixture.questionText } });
    check("SKIP duplicate strategy did not create a second Question row", questionCountAfterDup === 1);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    if (createdIds.questions.length) await prisma.question.deleteMany({ where: { id: { in: createdIds.questions } } });
    if (createdIds.runs.length) {
      await prisma.bulkImportRow.deleteMany({ where: { runId: { in: createdIds.runs } } });
      await prisma.bulkImportRun.deleteMany({ where: { id: { in: createdIds.runs } } });
    }
    if (createdIds.exams.length) await prisma.exam.deleteMany({ where: { id: { in: createdIds.exams } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
