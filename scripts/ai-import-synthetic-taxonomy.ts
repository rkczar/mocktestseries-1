/**
 * SYNTHETIC RUHS MO exam + taxonomy for scripts/verify-ai-import.ts and
 * verify-ai-import-ui.mjs, so the importer suites run on a freshly migrated
 * scratch DB WITHOUT a copy of production. Only the subject / topic names the
 * fixtures (scripts/ai-import-fixtures.ts) and the suites look up are created.
 *
 *   DATABASE_URL=<scratch> npx tsx prisma/seed.ts            # roles + MASTER_ADMIN (ADMIN_SEED_*)
 *   DATABASE_URL=<scratch> npx tsx scripts/ai-import-synthetic-taxonomy.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const TAXONOMY: Record<string, string[]> = {
  Anatomy: ["Head & Neck", "Upper Limb", "Lower Limb", "Neuroanatomy", "Histology"],
  Physiology: ["Cardiovascular System", "Renal Physiology", "Respiratory System", "Special Senses"],
  Biochemistry: ["Enzymes", "Nutrition"],
};

async function main() {
  if (await prisma.exam.findUnique({ where: { code: "RUHSMO" } })) throw new Error("Already seeded (exam RUHSMO exists).");
  const exam = await prisma.exam.create({ data: { name: "SYNTHETIC RUHS Medical Officer", code: "RUHSMO", isActive: true, durationMinutes: 120, totalQuestions: 100, negativeMarking: 0 } });
  for (const [i, [name, topics]] of Object.entries(TAXONOMY).entries()) {
    const s = await prisma.subject.create({ data: { name, nameKey: taxonomyNameKey(name), originExamId: exam.id, order: i } });
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: i } });
    for (const [t, topic] of topics.entries()) {
      const row = await prisma.topic.create({ data: { subjectId: s.id, name: topic, nameKey: taxonomyNameKey(topic), order: t } });
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: row.id, displayOrder: t } });
    }
  }
  console.log(JSON.stringify({ examId: exam.id, subjects: Object.keys(TAXONOMY).length, topics: Object.values(TAXONOMY).flat().length }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
