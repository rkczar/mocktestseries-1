/**
 * SYNTHETIC production-shaped data for scripts/critical-flows-fixture.ts +
 * verify-critical-flows.mjs + verify-site-crawl.mjs, so the critical student
 * journeys run WITHOUT a copy of production (no real student, payment, key or
 * SMS data ever enters the database).
 *
 * Seeds, on a freshly migrated scratch DB (prisma/seed.ts first for roles):
 * PAID payment mode with a FAKE TEST-environment Razorpay row (no request can
 * reach Razorpay: the secret is not real), every SMS / OTP provider left
 * unconfigured, one active exam with a public page and default enrollment,
 * 2 subjects × 2 topics, 60 published questions, the canonical Mock Test
 * Series (FREE + PAID + an unreleased PAID mock), its PAID TEST_SERIES
 * product, an active PYQ paper, a Practice OMR sheet (scratch STORAGE_DIR) and
 * a published homepage whose Featured Exam is the synthetic exam.
 *
 * Refuses to run unless the database name contains "flows".
 *
 *   set -a; . ./.env; set +a; export STORAGE_DIR=<scratch>   # AFTER sourcing .env
 *   DATABASE_URL=<scratch *flows*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/critical-flows-synthetic-seed.ts
 *   … then scripts/critical-flows-fixture.ts setup (students) as usual.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secret-cipher";
import { testResourcesDir, randomResourceFilename, publicResourceUrlFor } from "@/lib/test-resources";
import { buildOmrPdf } from "@/lib/omr-sheet";
import { DEFAULT_HOMEPAGE_SEO } from "@/lib/homepage";
import { SECTION_META, SECTION_ORDER } from "@/lib/homepage-sections";
import type { Prisma } from "@prisma/client";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!/flows/.test(dbName)) {
  console.error("Refusing to run: DATABASE_URL is not a *flows* scratch database.");
  process.exit(2);
}
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www")) {
  console.error("Refusing to run: STORAGE_DIR must point at scratch storage.");
  process.exit(2);
}

const TAG = "CFSYN";
const DAY = 86_400_000;

async function main() {
  if (await prisma.exam.findUnique({ where: { code: TAG } })) throw new Error("Already seeded (exam CFSYN exists).");
  const setting = (key: string, value: object) => prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  await setting("payments.mode", { mode: "PAID" });
  await setting("api.razorpay", { enabled: true, environment: "TEST", test: { keyId: "rzp_test_CFSYN0000000", keySecretCipher: encryptSecret("cfsyn-not-a-real-secret") } });

  const exam = await prisma.exam.create({
    data: { name: "SYNTHETIC MEDICAL OFFICER EXAM 2026", code: TAG, isActive: true, publicSlug: "synthetic-mo", publicPageEnabled: true, durationMinutes: 120, totalQuestions: 100, negativeMarking: 0 },
  });
  await setting("student.defaultExam", { examId: exam.id });

  const subjects = [];
  for (const [i, name] of ["Synthetic Medicine", "Synthetic Surgery"].entries()) {
    const s = await prisma.subject.create({ data: { name, nameKey: `cfsyn-${i}`, originExamId: exam.id, order: i } });
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: i } });
    const topics = [];
    for (const t of [1, 2]) {
      const topic = await prisma.topic.create({ data: { subjectId: s.id, name: `${name} Topic ${t}`, nameKey: `cfsyn-${i}-${t}` } });
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: topic.id, displayOrder: t } });
      topics.push(topic);
    }
    subjects.push({ s, topics });
  }

  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "SYNTHETIC MO 2024 Paper", paperCode: `${TAG}-2024`, isActive: true } });

  const questionIds: string[] = [];
  for (let n = 1; n <= 60; n++) {
    const { s, topics } = subjects[n % 2];
    const pyq = n > 50;
    const q = await prisma.question.create({
      data: {
        code: `${TAG}-Q${String(n).padStart(3, "0")}`,
        examId: exam.id,
        subjectId: s.id,
        topicId: topics[n % 4 < 2 ? 0 : 1].id,
        text: `Synthetic question ${n}: which option is correct?`,
        status: "PUBLISHED",
        source: pyq ? "PYQ" : "QUESTION_BANK",
        previousYearPaperId: pyq ? paper.id : null,
        examYear: pyq ? 2024 : null,
        explanation: `Synthetic explanation ${n}.`,
        options: { create: ["A", "B", "C", "D"].map((label, i) => ({ label, text: `Option ${label} of question ${n}`, isCorrect: i === n % 4 })) },
      },
    });
    questionIds.push(q.id);
  }

  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: "Synthetic MO Mock Test Series", slug: "synthetic-mo-mock-test-series", status: "PUBLISHED", isActive: true, testCount: 10 } });
  const mock = async (title: string, accessType: "FREE" | "PAID", order: number, availableFrom: Date | null, qs: string[]) => {
    const m = await prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title, durationMinutes: 60, accessType, status: "PUBLISHED", availableFrom, order } });
    await prisma.mockTestQuestion.createMany({ data: qs.map((questionId, i) => ({ mockTestId: m.id, questionId, order: i })) });
    return m;
  };
  const freeMock = await mock("Synthetic Mock 1 (Free)", "FREE", 0, null, questionIds.slice(0, 10));
  const paidMock = await mock("Synthetic Mock 2", "PAID", 1, null, questionIds.slice(10, 20));
  const upcoming = await mock("Synthetic Mock 3 (Upcoming)", "PAID", 2, new Date(Date.now() + 7 * DAY), questionIds.slice(20, 30));

  const product = await prisma.product.create({
    data: {
      code: "cfsyn-series", name: "Synthetic MO Complete Mock Test Series", productType: "TEST_SERIES", accessType: "PAID", isActive: true, isVisible: true, purchaseEnabled: true,
      examId: exam.id, testSeriesId: series.id, mrpPaise: 99900, sellingPricePaise: 49900, accessDurationType: "DAYS", accessDays: 365,
    },
  });

  const bytes = await buildOmrPdf("Synthetic MO — Practice OMR (100 Questions)", 100);
  const filename = randomResourceFilename("application/pdf")!;
  await fs.mkdir(testResourcesDir(), { recursive: true });
  await fs.writeFile(path.join(testResourcesDir(), filename), bytes);
  await prisma.testResource.create({
    data: { type: "OMR_TEMPLATE", title: "Practice OMR — 100 Questions", fileUrl: publicResourceUrlFor(filename), mimeType: "application/pdf", fileSizeBytes: bytes.length, questionCount: 100, examId: exam.id, testSeriesId: series.id },
  });

  const seriesHref = `/exams/${exam.publicSlug}/mock-test-series`;
  const papersHref = `/exams/${exam.publicSlug}/previous-year-papers`;
  const LINKS: Partial<Record<(typeof SECTION_ORDER)[number], Record<string, string>>> = {
    HERO: { primaryCtaHref: seriesHref, secondaryCtaHref: papersHref },
    MOCK_TEST_PROMOTION: { ctaHref: seriesHref },
    PREVIOUS_YEAR_PAPERS: { ctaHref: papersHref },
    CTA: { buttonHref: seriesHref },
  };
  // A published homepage like production's: the documented defaults, Featured Exam = the synthetic exam
  // (the hero / Start for Free sections take their exam from it).
  await prisma.homepageConfig.create({
    data: {
      version: 1,
      status: "PUBLISHED",
      publishedAt: new Date(),
      seo: { ...DEFAULT_HOMEPAGE_SEO },
      sections: {
        create: SECTION_ORDER.map((key, order) => ({
          key,
          order,
          isEnabled: true,
          // The defaults' "/login" placeholder links are replaced by real pages, as an admin does before publishing.
          content: { ...(SECTION_META[key].defaultContent as object), ...(LINKS[key] ?? {}) } as Prisma.InputJsonValue,
          references: key === "FEATURED_EXAM" ? { examId: exam.id } : {},
        })),
      },
    },
  });

  console.log(JSON.stringify({ examId: exam.id, examSlug: exam.publicSlug, productCode: product.code, freeMockId: freeMock.id, paidMockId: paidMock.id, upcomingMockId: upcoming.id, paperId: paper.id, questions: questionIds.length }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
