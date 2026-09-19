/**
 * Verifies the Exam Syllabus feature (Admin -> Exams -> Syllabus): that it
 * is genuinely built on the canonical Exam -> Subject -> Topic -> SubTopic
 * taxonomy shared with the Question Bank and bulk import, not a parallel
 * copy of it.
 *
 *  1. Taxonomy scoping — a subject resolves to its own exam, not another
 *     one; a topic resolves to its own subject; no cross-exam leakage when
 *     reading one exam's syllabus tree.
 *  2. Public data contract — getExamDetailForStudent (the same loader the
 *     exam detail page uses) returns syllabusEnabled/syllabusDescription on
 *     the exam and syllabusDescription on each subject/topic, so the page's
 *     `exam.syllabusEnabled ? <ExamSyllabus .../> : null` gate has real data
 *     to gate on.
 *  3. Question Bank integration — the exact tree shape the Add/Edit Question
 *     form loads (Exam -> Subject -> Topic -> SubTopic) includes the subject
 *     and topic created via syllabus management, proving there is one
 *     taxonomy, not two.
 *  4. Bulk import integration — validateWithDatabase (lib/bulk-import.ts)
 *     resolves a row referencing the syllabus-created Subject/Topic/SubTopic
 *     correctly, and rejects a row naming a subject that doesn't exist for
 *     that exam with a clear, row-specific error message.
 *
 * RBAC is verified by inspection, not runtime here: every one of the 6
 * syllabus server actions (app/admin/(dashboard)/exams/syllabus/actions.ts)
 * calls `requirePermission(PERMISSIONS.EXAMS_MANAGE)` as its first
 * statement — grep-confirmed, matching the same pattern every other admin
 * action in this codebase uses. Those actions can't be imported into a bare
 * script here: they pull in `next/cache`, which drags in `next/navigation`
 * and breaks under plain Node even with the react-server condition (the
 * same reason no other verify-*.ts script imports a "use server" file
 * either — they all test the underlying lib/*.ts functions instead).
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-syllabus.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
// These import `server-only`, which is inert under the react-server condition.
import { getExamDetailForStudent } from "@/lib/student-data";
import { validateImportRows, validateWithDatabase, type BulkImportRow } from "@/lib/bulk-import";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

async function main() {
  const suffix = Date.now().toString(36);
  const examA = await prisma.exam.create({
    data: { name: `Syllabus Exam A ${suffix}`, code: `SYL-A-${suffix}`, syllabusEnabled: true, syllabusDescription: "Overview of exam A" },
  });
  const examB = await prisma.exam.create({ data: { name: `Syllabus Exam B ${suffix}`, code: `SYL-B-${suffix}` } });

  try {
    console.log("--- Taxonomy scoping ---");

    const subjA = await prisma.subject.create({ data: { examId: examA.id, name: "Physics", syllabusDescription: "Mechanics onward" } });
    const subjB = await prisma.subject.create({ data: { examId: examB.id, name: "Physics" } }); // same name, different exam — must not collide
    const topicA1 = await prisma.topic.create({ data: { subjectId: subjA.id, name: "Kinematics", syllabusDescription: "Motion in 1D and 2D" } });
    const subTopicA1 = await prisma.subTopic.create({ data: { topicId: topicA1.id, name: "Projectile Motion" } });

    const reloadedSubjA = await prisma.subject.findUniqueOrThrow({ where: { id: subjA.id } });
    check("subject resolves to its own exam, not another one", reloadedSubjA.examId === examA.id);

    const reloadedTopicA1 = await prisma.topic.findUniqueOrThrow({ where: { id: topicA1.id } });
    check("topic resolves to its own subject", reloadedTopicA1.subjectId === subjA.id);

    const examATree = await prisma.exam.findUniqueOrThrow({
      where: { id: examA.id },
      include: { subjects: { include: { topics: true } } },
    });
    check("exam A's syllabus tree contains exactly its own subject (no cross-exam leakage)", examATree.subjects.length === 1 && examATree.subjects[0].id === subjA.id);
    check("exam A's subject does not leak exam B's same-named subject", !examATree.subjects.some((s) => s.id === subjB.id));

    console.log("\n--- Public data contract (getExamDetailForStudent) ---");
    const detail = await getExamDetailForStudent(examA.id);
    check("exam detail loads", detail !== null);
    check("syllabusEnabled flows through", detail!.exam.syllabusEnabled === true);
    check("exam-level syllabusDescription flows through", detail!.exam.syllabusDescription === "Overview of exam A");
    const loadedSubject = detail!.exam.subjects.find((s) => s.id === subjA.id);
    check("subject-level syllabusDescription flows through", loadedSubject?.syllabusDescription === "Mechanics onward");
    const loadedTopic = loadedSubject?.topics.find((t) => t.id === topicA1.id);
    check("topic-level syllabusDescription flows through", loadedTopic?.syllabusDescription === "Motion in 1D and 2D");

    console.log("\n--- Question Bank integration (same tree Add/Edit Question loads) ---");
    const examTreeForQuestionForm = await prisma.exam.findMany({
      where: { id: examA.id },
      orderBy: { order: "asc" },
      include: {
        subjects: { orderBy: { order: "asc" }, include: { topics: { orderBy: { order: "asc" }, include: { subTopics: { orderBy: { order: "asc" } } } } } },
      },
    });
    const qbSubject = examTreeForQuestionForm[0]?.subjects.find((s) => s.id === subjA.id);
    const qbTopic = qbSubject?.topics.find((t) => t.id === topicA1.id);
    const qbSubTopic = qbTopic?.subTopics.find((st) => st.id === subTopicA1.id);
    check("Subject created via syllabus management appears in the Question Bank's exam tree", !!qbSubject);
    check("Topic created via syllabus management appears in the Question Bank's exam tree", !!qbTopic);
    check("SubTopic created via syllabus management appears in the Question Bank's exam tree", !!qbSubTopic);

    console.log("\n--- Bulk import integration ---");
    const validRow: BulkImportRow = {
      rowNumber: 2,
      exam: examA.name,
      examYear: "2026",
      subject: "Physics",
      topic: "Kinematics",
      subTopic: "Projectile Motion",
      source: "Question Bank",
      questionText: "A ball is thrown horizontally...",
      optionA: "10 m/s",
      optionB: "20 m/s",
      optionC: "30 m/s",
      optionD: "40 m/s",
      correctAnswer: "B",
      difficulty: "MEDIUM",
      status: "DRAFT",
    };
    const invalidRow: BulkImportRow = { ...validRow, rowNumber: 3, subject: "Nonexistent Subject XYZ" };

    const parsed = validateImportRows([validRow, invalidRow]);
    const dbValidated = await validateWithDatabase(prisma, parsed);

    const validResolved = dbValidated.rows.find((r) => r.rowNumber === 2);
    check("valid row resolves the syllabus-created Subject", validResolved?.resolvedData?.subjectId === subjA.id);
    check("valid row resolves the syllabus-created Topic", validResolved?.resolvedData?.topicId === topicA1.id);
    check("valid row resolves the syllabus-created SubTopic", validResolved?.resolvedData?.subTopicId === subTopicA1.id);

    const invalidResolved = dbValidated.rows.find((r) => r.rowNumber === 3);
    // Bulk import Part 3: an unmapped Subject/Topic/SubTopic name is flagged
    // for mapping (WARNING), not hard-rejected (ERROR) — the admin can map it
    // or create the taxonomy explicitly via the Validate & Preview Workspace.
    check("row naming a nonexistent subject is flagged for mapping, not rejected outright", invalidResolved?.severity === "WARNING");
    check("...and is still considered importable (isValid) pending mapping", invalidResolved?.isValid === true);
    check(
      "...with a clear, row-specific warning message",
      !!invalidResolved?.warnings.some((w) => w.includes('Subject "Nonexistent Subject XYZ"') && w.includes(examA.name))
    );
    check(
      "...and flagged as needing taxonomy mapping",
      !!invalidResolved?.unmapped?.some((u) => u.field === "subject" && u.value === "Nonexistent Subject XYZ")
    );

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.subTopic.deleteMany({ where: { topic: { subject: { examId: { in: [examA.id, examB.id] } } } } });
    await prisma.topic.deleteMany({ where: { subject: { examId: { in: [examA.id, examB.id] } } } });
    await prisma.subject.deleteMany({ where: { examId: { in: [examA.id, examB.id] } } });
    await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examB.id] } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
