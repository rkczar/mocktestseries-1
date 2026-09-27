/**
 * Canonical reusable taxonomy regression (Subject -> Topic -> SubTopic shared
 * across exams via ExamSubject / ExamTopic / ExamSubTopic).
 *
 * Disposable fixtures only: two throwaway exams; the only writes to shared
 * masters are link rows on those throwaway exams, plus one disposable
 * sub-topic that is deleted again. Run against a scratch/rehearsal DB:
 *   DATABASE_URL=… NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-canonical-taxonomy.ts
 */
import "dotenv/config";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  TaxonomyInUseError,
  findOrCreateSubTopic,
  findOrCreateSubject,
  findOrCreateTopic,
  getExamTaxonomy,
  linkSubTopicToExam,
  linkSubjectToExam,
  linkTopicToExam,
  taxonomyNameKey,
  unlinkSubjectFromExam,
} from "@/lib/exam-taxonomy";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, resolveRow, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { getSubjectTestSetup, getExamDetailForStudent } from "@/lib/student-data";
import { countPublishedQuestions, assertValidOwnershipChain } from "@/lib/question-selection";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const counts = async () => ({
  subjects: await prisma.subject.count(),
  topics: await prisma.topic.count(),
  subTopics: await prisma.subTopic.count(),
});

async function main() {
  console.log("=== Canonical Taxonomy Verification ===\n");
  const suffix = Date.now().toString(36);
  const source = await prisma.exam.findFirstOrThrow({
    where: { examSubjects: { some: {} }, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { examSubjects: { _count: "desc" } },
  });
  const sourceTree = await getExamTaxonomy(prisma, source.id);
  const anatomy = sourceTree.find((s) => s.topics.length > 0)!;
  const anatomyTopic = anatomy.topics[0];
  const before = await counts();
  const sourceLinksBefore = await prisma.examSubject.count({ where: { examId: source.id } });
  const pyq = await prisma.question.findFirst({ where: { previousYearPaperId: { not: null } }, select: { id: true, examId: true, previousYearPaperId: true, subjectId: true } });

  const examX = await prisma.exam.create({ data: { name: `TAX-X ${suffix}`, code: `TAXX-${suffix}`, year: 2026 } });
  const examY = await prisma.exam.create({ data: { name: `TAX-Y ${suffix}`, code: `TAXY-${suffix}`, year: 2026 } });
  let fixtureSubTopicId: string | null = null;
  const runIds: string[] = [];

  try {
    console.log(`Source exam: ${source.name}; sample subject "${anatomy.name}" / topic "${anatomyTopic.name}"`);

    console.log("\n1. Reusable Subject / Topic (no duplicates)");
    await linkSubjectToExam(prisma, examX.id, anatomy.id);
    const again = await findOrCreateSubject(prisma, `  ${anatomy.name.toUpperCase()}   `, examX.id);
    check("re-creating an existing subject (case/space variant) returns the SAME record", !again.created && again.record.id === anatomy.id);
    await linkTopicToExam(prisma, examX.id, anatomyTopic.id);
    const topicAgain = await findOrCreateTopic(prisma, anatomy.id, anatomyTopic.name.toLowerCase());
    check("re-creating an existing topic returns the SAME record", !topicAgain.created && topicAgain.record.id === anatomyTopic.id);
    const mid = await counts();
    check("no Subject/Topic rows created by linking", mid.subjects === before.subjects && mid.topics === before.topics, { before, mid });
    const xTree = await getExamTaxonomy(prisma, examX.id);
    check("exam X shows the linked subject + only the selected topic", xTree.length === 1 && xTree[0].id === anatomy.id && xTree[0].topics.length === 1);

    console.log("\n2. Reusable SubTopic (disposable fixture)");
    const st = await findOrCreateSubTopic(prisma, anatomyTopic.id, `TAX Fixture SubTopic ${suffix}`);
    fixtureSubTopicId = st.record.id;
    await linkSubTopicToExam(prisma, examX.id, st.record.id);
    await linkSubTopicToExam(prisma, examY.id, st.record.id);
    const stAgain = await findOrCreateSubTopic(prisma, anatomyTopic.id, `tax fixture subtopic ${suffix}`);
    check("sub-topic duplicate protection returns the same record", !stAgain.created && stAgain.record.id === st.record.id);
    check("one sub-topic record linked to two exams", (await prisma.examSubTopic.count({ where: { subTopicId: st.record.id } })) === 2);
    check("linking a sub-topic cascades its topic + subject links (exam Y)", (await prisma.examTopic.count({ where: { examId: examY.id, topicId: anatomyTopic.id } })) === 1 && (await prisma.examSubject.count({ where: { examId: examY.id, subjectId: anatomy.id } })) === 1);

    console.log("\n3. Use Taxonomy From Existing Exam (links only)");
    for (const s of sourceTree) {
      await linkSubjectToExam(prisma, examY.id, s.id);
      for (const t of s.topics) await linkTopicToExam(prisma, examY.id, t.id);
    }
    const yTree = await getExamTaxonomy(prisma, examY.id);
    check("exam Y now links every source subject", yTree.length === sourceTree.length, { y: yTree.length, src: sourceTree.length });
    check("topics linked = source topics", yTree.reduce((n, s) => n + s.topics.length, 0) === sourceTree.reduce((n, s) => n + s.topics.length, 0));
    const after = await counts();
    check("master Subject/Topic counts unchanged (no copies)", after.subjects === before.subjects && after.topics === before.topics, { before, after });

    console.log("\n4. Remove from Exam = unlink, master remains");
    await unlinkSubjectFromExam(prisma, examX.id, anatomy.id);
    check("subject unlinked from X", (await prisma.examSubject.count({ where: { examId: examX.id, subjectId: anatomy.id } })) === 0);
    check("X's topic/sub-topic links under it removed too", (await prisma.examTopic.count({ where: { examId: examX.id } })) === 0 && (await prisma.examSubTopic.count({ where: { examId: examX.id } })) === 0);
    check("master subject still exists", (await prisma.subject.count({ where: { id: anatomy.id } })) === 1);
    check("source exam's link untouched", (await prisma.examSubject.count({ where: { examId: source.id } })) === sourceLinksBefore);
    check("exam Y's link untouched", (await prisma.examSubject.count({ where: { examId: examY.id, subjectId: anatomy.id } })) === 1);

    console.log("\n5. Bulk Import resolves canonical taxonomy (exam X, subject not yet linked)");
    const csv = [
      "exam,year,subject,topic,question_text,option_a,option_b,option_c,option_d,correct_answer,difficulty,status",
      `${examX.name},2026,${anatomy.name.toLowerCase()},${anatomyTopic.name},TAX ${suffix} imported question?,A1,B1,C1,D1,A,MEDIUM,PUBLISHED`,
    ].join("\n");
    const { rows } = await parseImportFile(new File([csv], `tax-${suffix}.csv`));
    const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: admin.id,
        filename: `tax-${suffix}.csv`,
        examId: examX.id,
        totalRows: rows.length,
        duplicateStrategy: "SKIP",
        status: BulkImportStatus.UPLOADED,
        rows: { create: rows.map((r: BulkImportRow) => ({ rowNumber: r.rowNumber, status: BulkImportRowStatus.PENDING, severity: ImportRowSeverity.ERROR, rawData: r as unknown as Prisma.InputJsonValue })) },
      },
    });
    runIds.push(run.id);
    const lookups = await buildTaxonomyLookups(prisma);
    const [shape] = validateImportRows([mergeRowData(rows[0], null)]);
    const resolved = await resolveRow(prisma, lookups, shape, undefined, lookups.exams.find((e) => e.id === examX.id) ?? null);
    check("row resolves to the canonical subject id", resolved.resolvedData?.subjectId === anatomy.id, resolved.errors);
    check("row resolves to the canonical topic id", resolved.resolvedData?.topicId === anatomyTopic.id);
    check("not-yet-linked canonical record is a warning, not an error", resolved.severity === ImportRowSeverity.WARNING && resolved.warnings.some((w) => w.includes("will be linked on import")), resolved.warnings);
    const exec = await executeBulkImport({ runId: run.id, adminUserId: admin.id });
    check("import created 1 question", exec.successCount === 1, exec);
    const imported = await prisma.question.findFirst({ where: { importBatchId: run.id } });
    check("imported question uses canonical subject/topic", imported?.subjectId === anatomy.id && imported?.topicId === anatomyTopic.id);
    check("import linked the subject/topic to exam X", (await prisma.examTopic.count({ where: { examId: examX.id, topicId: anatomyTopic.id } })) === 1);
    const row = await prisma.bulkImportRow.findFirst({ where: { runId: run.id } });
    check("import row records the created question id + CREATED action (SUCCESS)", row?.questionId === imported?.id && row?.status === "SUCCESS");
    check("no taxonomy rows created by import", (await prisma.subject.count()) === before.subjects && (await prisma.topic.count()) === before.topics);

    console.log("\n6. Unlink protection while exam questions use it");
    let blocked = false;
    try {
      await unlinkSubjectFromExam(prisma, examX.id, anatomy.id);
    } catch (e) {
      blocked = e instanceof TaxonomyInUseError;
    }
    check("Remove-from-exam refused while exam X has questions in the subject", blocked);

    console.log("\n7. Question applicability: shared taxonomy ≠ shared questions");
    const xCount = await countPublishedQuestions({ examId: examX.id, subjectId: anatomy.id });
    check("exam X sees only its own question in the shared subject", xCount === 1, xCount);
    const yCount = await countPublishedQuestions({ examId: examY.id, subjectId: anatomy.id });
    check("exam Y (links the subject, owns no questions) sees 0 — no auto-sharing", yCount === 0, yCount);
    const srcCount = await countPublishedQuestions({ examId: source.id, subjectId: anatomy.id });
    check("source exam's count excludes exam X's new question", srcCount === (await prisma.question.count({ where: { examId: source.id, subjectId: anatomy.id, status: "PUBLISHED" } })));
    let chainOk = true;
    try {
      await assertValidOwnershipChain({ examId: examY.id, subjectId: anatomy.id, topicId: anatomyTopic.id });
    } catch {
      chainOk = false;
    }
    check("exam-scoped selection accepts linked subject/topic", chainOk);

    console.log("\n8. Student filters respect exam links");
    const setupX = await getSubjectTestSetup(examX.id);
    check("Subject Test setup for X lists only X's linked subjects", setupX?.exam.subjects.length === 1 && setupX.exam.subjects[0].id === anatomy.id);
    const detailY = await getExamDetailForStudent(examY.id);
    check("student exam detail for Y shows Y's linked taxonomy", detailY?.exam.subjects.length === sourceTree.length);

    console.log("\n9. PYQ provenance unchanged");
    if (pyq) {
      const now = await prisma.question.findUnique({ where: { id: pyq.id }, select: { examId: true, previousYearPaperId: true, subjectId: true } });
      check("PYQ question keeps its source exam + paper + subject", now?.examId === pyq.examId && now?.previousYearPaperId === pyq.previousYearPaperId && now?.subjectId === pyq.subjectId);
    } else check("PYQ sample available", false);

    console.log("\n10. Normalized key");
    check("taxonomyNameKey trims/collapses/lowercases", taxonomyNameKey("  Upper   Limb ") === "upper limb");
  } finally {
    console.log("\nCleaning up disposable fixtures...");
    await prisma.question.deleteMany({ where: { examId: { in: [examX.id, examY.id] } } });
    await prisma.bulkImportRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.exam.deleteMany({ where: { id: { in: [examX.id, examY.id] } } }); // links cascade; masters stay
    if (fixtureSubTopicId) await prisma.subTopic.delete({ where: { id: fixtureSubTopicId } });
    const end = await counts();
    check("after cleanup: master Subject/Topic/SubTopic counts back to baseline", end.subjects === before.subjects && end.topics === before.topics && end.subTopics === before.subTopics, { before, end });
    check("after cleanup: shared subject survived deleting exams that linked it", (await prisma.subject.count({ where: { id: anatomy.id } })) === 1);
    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
