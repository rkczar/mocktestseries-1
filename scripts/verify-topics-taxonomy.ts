/**
 * Regression coverage for the Admin -> Exams -> Topics fix: the "Topic
 * Name" field was wrongly capped at <=120 characters (Zod schema only —
 * there was never a matching DB, HTML maxLength, or frontend restriction),
 * which rejected genuine long medical/scientific chapter titles. Fixed by
 * raising the cap to a generous DB-safe TOPIC_NAME_MAX_LENGTH (500,
 * lib/topic-taxonomy.ts) and adding an actual duplicate-name guard (there
 * was none before), plus a new "Bulk Add Topics" (one per line) flow.
 *
 * Covers: a name over the old 120-char cap is accepted and saved intact;
 * an empty/whitespace-only name is rejected; an exact case-insensitive
 * duplicate under the same subject is rejected, but the same name is fine
 * under a different subject; bulk add trims, skips blank lines, de-dupes
 * both within the pasted batch and against existing topics, and is
 * idempotent (re-running it creates nothing new).
 *
 * Run from the repo root with the react-server condition so `import
 * "server-only"` resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-topics-taxonomy.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createTopicChecked, bulkCreateTopics, topicSchema } from "@/lib/topic-taxonomy";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Topics Fix Exam ${suffix}`, code: `TFX-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Botany" } });

  try {
    const longName =
      "Structural Organisation in Plants and Animals: Morphology, Anatomy and Functional Organisation of Root, Stem, Leaf, Flower, and Their Modifications in Flowering Plants (a genuinely long but real syllabus chapter title)";
    check("name is actually longer than the old 120-char cap", longName.length > 120);

    const r1 = await createTopicChecked(prisma, subject.id, longName);
    check("a topic name over 120 characters is accepted", "topic" in r1);
    const savedLong = await prisma.topic.findFirst({ where: { subjectId: subject.id, name: longName } });
    check("the full long name was saved without truncation", savedLong?.name === longName);

    const emptyParsed = topicSchema.safeParse({ subjectId: subject.id, name: "   " });
    check("an empty/whitespace-only name is rejected by the form schema before it ever reaches the DB", !emptyParsed.success);

    const r3 = await createTopicChecked(prisma, subject.id, "Cell Structure and Function");
    check("first creation of a normal name succeeds", "topic" in r3);

    const r4 = await createTopicChecked(prisma, subject.id, "cell structure and function"); // different case, same topic
    check("an exact (case-insensitive) duplicate under the same subject is rejected", "error" in r4);

    const otherSubject = await prisma.subject.create({ data: { examId: exam.id, name: "Zoology" } });
    const r5 = await createTopicChecked(prisma, otherSubject.id, "Cell Structure and Function");
    check("the same name is allowed under a different subject", "topic" in r5);

    console.log("\n--- Bulk Add ---");
    const pasted = [
      "Diversity in Living World",
      "",
      "  Plant Physiology  ",
      "Cell Structure and Function", // duplicate of an existing topic under `subject`
      "Plant Physiology", // duplicate within the pasted batch itself
      "   ",
      "Human Physiology",
    ].join("\n");

    const bulkResult = await bulkCreateTopics(subject.id, pasted);
    check("bulk add returns a result (no top-level error)", !bulkResult.error);
    check("blank lines are ignored (not counted as failed or added)", bulkResult.result?.added.length === 3);
    check(
      "added contains exactly the 3 genuinely new names",
      JSON.stringify([...bulkResult.result!.added].sort()) === JSON.stringify(["Diversity in Living World", "Human Physiology", "Plant Physiology"].sort())
    );
    check("existing duplicate (Cell Structure and Function) skipped", bulkResult.result!.duplicates.includes("Cell Structure and Function"));
    check("in-batch duplicate (second Plant Physiology) skipped", bulkResult.result!.duplicates.filter((d) => d === "Plant Physiology").length === 1);

    const allTopics = await prisma.topic.findMany({ where: { subjectId: subject.id } });
    check("exactly the expected topics now exist under this subject (no dupes created)", allTopics.length === 5); // long name, Cell Structure, + 3 bulk-added

    const bulkAgain = await bulkCreateTopics(subject.id, "Diversity in Living World");
    check("re-running bulk add with an already-existing name adds nothing new", bulkAgain.result?.added.length === 0 && bulkAgain.result?.duplicates.length === 1);
    const countAfterRerun = await prisma.topic.count({ where: { subjectId: subject.id } });
    check("no duplicate row was created on re-run", countAfterRerun === 5);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.topic.deleteMany({ where: { subject: { examId: exam.id } } });
    await prisma.subject.deleteMany({ where: { examId: exam.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
