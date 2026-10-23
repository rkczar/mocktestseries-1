/**
 * SYNTHETIC RUHS-shaped exam for scripts/verify-seo-phase2.mjs (titles,
 * descriptions, tentative exam date, official sources, internal links).
 * Run AFTER scripts/critical-flows-synthetic-seed.ts on the same scratch DB:
 * it turns the synthetic exam into code RUHSMO / slug rajasthan-medical-officer
 * (so the exam's editorial facts apply) and adds past papers until the
 * subject-wise weightage, paper analysis and preparation strategy pages exist.
 * No production data: every question, paper and date is made up.
 *
 * Refuses to run unless the database name contains "seop2".
 *
 *   DATABASE_URL=<scratch *seop2*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/seo-phase2-fixture.ts
 */
import { prisma } from "@/lib/prisma";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!/seop2/.test(dbName)) {
  console.error("Refusing to run: DATABASE_URL is not a *seop2* scratch database.");
  process.exit(2);
}

const DAY = 86_400_000;
const EXTRA_SUBJECTS = ["Synthetic Pediatrics", "Synthetic Pathology", "Synthetic Pharmacology", "Synthetic PSM", "Synthetic ENT"];

async function main() {
  const exam = await prisma.exam.findUnique({ where: { code: "CFSYN" } });
  if (!exam) throw new Error("Run scripts/critical-flows-synthetic-seed.ts first (exam CFSYN missing).");
  // Midnight UTC, 51 days ahead: the homepage shows "About 51 days left".
  const examDate = new Date(Math.floor((Date.now() + 51 * DAY) / DAY) * DAY);
  await prisma.exam.update({
    where: { id: exam.id },
    data: {
      code: "RUHSMO",
      name: "RUHS Medical Officer 2026",
      year: 2026,
      publicSlug: "rajasthan-medical-officer",
      examDate,
      upcomingDate: examDate,
      importantDates: [
        { label: "Written examination", date: "Synthetic date (tentative)" },
        { label: "Admit card", date: "To be announced" },
      ],
    },
  });

  // The seeded homepage links the old slug in its section content: follow the rename.
  for (const s of await prisma.homepageSection.findMany()) {
    const json = JSON.stringify(s.content ?? null);
    if (json.includes("/exams/synthetic-mo")) {
      await prisma.homepageSection.update({ where: { id: s.id }, data: { content: JSON.parse(json.replaceAll("/exams/synthetic-mo", "/exams/rajasthan-medical-officer")) } });
    }
  }

  const linked = await prisma.examSubject.findMany({ where: { examId: exam.id }, include: { subject: { include: { topics: true } } }, orderBy: { displayOrder: "asc" } });
  const subjects = linked.map((l) => ({ id: l.subject.id, topicId: l.subject.topics[0]?.id ?? null }));
  for (const [i, name] of EXTRA_SUBJECTS.entries()) {
    const s = await prisma.subject.create({ data: { name, nameKey: `seop2-${i}`, originExamId: exam.id, order: 10 + i } });
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: 10 + i } });
    const t = await prisma.topic.create({ data: { subjectId: s.id, name: `${name} Topic 1`, nameKey: `seop2-${i}-1` } });
    await prisma.examTopic.create({ data: { examId: exam.id, topicId: t.id, displayOrder: 1 } });
    subjects.push({ id: s.id, topicId: t.id });
  }

  // 2024 already exists with 10 PYQs; add 90 more there, and three 100-question papers.
  const papers = [
    ...(await prisma.previousYearPaper.findMany({ where: { examId: exam.id, year: 2024 }, select: { id: true, year: true } })).map((p) => ({ ...p, add: 90 })),
  ];
  for (const year of [2013, 2019, 2022]) {
    const p = await prisma.previousYearPaper.create({ data: { examId: exam.id, year, title: `SYNTHETIC MO ${year} Paper`, paperCode: `SEOP2-${year}`, isActive: true } });
    papers.push({ id: p.id, year, add: 100 });
  }
  let n = 0;
  for (const p of papers) {
    for (let i = 0; i < p.add; i++, n++) {
      const s = subjects[n % subjects.length];
      await prisma.question.create({
        data: {
          code: `SEOP2-Q${String(n + 1).padStart(4, "0")}`,
          examId: exam.id,
          subjectId: s.id,
          topicId: s.topicId,
          text: `Synthetic past-paper question ${n + 1} (${p.year}).`,
          status: "PUBLISHED",
          source: "PYQ",
          previousYearPaperId: p.id,
          examYear: p.year,
          explanation: `Synthetic explanation ${n + 1}.`,
          options: { create: ["A", "B", "C", "D"].map((label, j) => ({ label, text: `Option ${label}`, isCorrect: j === n % 4 })) },
        },
      });
    }
  }
  console.log(JSON.stringify({ examId: exam.id, examDate: examDate.toISOString(), addedQuestions: n, papers: papers.map((p) => p.year) }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
