/**
 * SYNTHETIC Rajasthan FSO fixture for the multi-exam / FSO launch suites (scripts/verify-fso-launch.ts).
 * Runs on a scratch DB already seeded by scripts/critical-flows-synthetic-seed.ts (the RUHS-like exam
 * "CFSYN", its PAID product, Practice OMR). Adds, with placeholder text only (no real question):
 *   - exam RUHS-FSO (inactive, BILINGUAL) with 2019 / 2022 PYQ papers of 150 numbered questions,
 *     Hindi on every question/option, stored answers equal to the official keys (lib/fso-official.ts)
 *     except the 7 deleted questions, which are stored PUBLISHED with option 1 correct — as in production;
 *     2022 Q92 (same question as 2019 Q43) is its own 2022 record, excluded from practice — as in production after C1–C4;
 *   - coupons shaped like production: LIMITED10 (₹100, unrestricted), GROUP20 (product-scoped);
 *   - the ₹200 FSO EXAM_ACCESS product, hidden, purchase disabled, couponsAllowed=false, FIXED_DATE without a date.
 * Refuses to run unless the database name starts with "mts_fsol".
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=<mts_fsol_*> npx tsx scripts/fso-launch-fixture.ts
 */
import { prisma } from "@/lib/prisma";
import { FSO_PAPERS } from "@/lib/fso-official";
import { FSO_EXAM_CODE } from "@/lib/exam-downloads";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.startsWith("mts_fsol")) {
  console.error("Refusing to run: DATABASE_URL is not an mts_fsol* scratch database.");
  process.exit(2);
}

const LABELS = ["A", "B", "C", "D"];

async function main() {
  const ruhs = await prisma.exam.findUnique({ where: { code: "CFSYN" }, include: { testSeries: true } });
  if (!ruhs) throw new Error("Run scripts/critical-flows-synthetic-seed.ts first (exam CFSYN missing).");
  if (await prisma.exam.findUnique({ where: { code: FSO_EXAM_CODE } })) throw new Error("Already seeded (exam RUHS-FSO exists).");

  const fso = await prisma.exam.create({
    data: { name: "RAJASTHAN FOOD SAFETY OFFICER", code: FSO_EXAM_CODE, isActive: false, publicPageEnabled: false, languageMode: "BILINGUAL", year: 2026, order: 5 },
  });
  const subject = await prisma.subject.create({ data: { name: "Synthetic Food Science", nameKey: "fsol-food", originExamId: fso.id } });
  await prisma.examSubject.create({ data: { examId: fso.id, subjectId: subject.id, displayOrder: 0 } });

  for (const year of [2019, 2022] as const) {
    const facts = FSO_PAPERS[year];
    const paper = await prisma.previousYearPaper.create({
      data: { examId: fso.id, year, title: `RPSC FSO ${year} (synthetic)`, durationMinutes: facts.durationMinutes, isActive: true },
    });
    for (let n = 1; n <= 150; n++) {
      if (facts.reused?.[n]) continue; // stored once under the other paper, as in production
      const official = facts.answers[n - 1];
      const correct = official === 0 ? 1 : official; // deleted: stored with option 1 correct (untouched, as in prod)
      await prisma.question.create({
        data: {
          code: `FSOL ${year} Q${n}`,
          examId: fso.id,
          subjectId: subject.id,
          previousYearPaperId: paper.id,
          paperQuestionNumber: n,
          source: "PYQ",
          status: "PUBLISHED",
          ...(year === 2022 && n === 92 ? { excludeFromPractice: true, excludeFromPracticeReason: "Repeat of RPSC FSO 2019 Q43 (synthetic)" } : {}),
          text: `Synthetic ${year} question ${n}: which option is correct?`,
          textHi: `कृत्रिम ${year} प्रश्न ${n}: कौन सा विकल्प सही है? (खाद्य सुरक्षा)`,
          options: {
            create: LABELS.map((label, i) => ({
              label,
              order: i,
              text: `Option ${i + 1} for ${year} Q${n}`,
              textHi: `विकल्प ${i + 1} — प्रश्न ${n}`,
              isCorrect: i + 1 === correct,
            })),
          },
        },
      });
    }
  }

  const ruhsProduct = await prisma.product.findFirst({ where: { examId: ruhs.id, accessType: "PAID", productType: "TEST_SERIES" } });
  await prisma.coupon.createMany({
    data: [
      { code: "LIMITED10", discountType: "FIXED_AMOUNT", discountValue: 10000, isActive: true },
      { code: "GROUP20", discountType: "PERCENTAGE", discountValue: 20, isActive: true, productIds: ruhsProduct ? [ruhsProduct.id] : [] },
      { code: "RUHSONLY", discountType: "PERCENTAGE", discountValue: 10, isActive: true, examIds: [ruhs.id] },
      { code: "FSOONLY", discountType: "PERCENTAGE", discountValue: 10, isActive: true, examIds: [fso.id] },
    ],
  });

  await prisma.product.create({
    data: {
      code: "rpsc-fso-full-access",
      name: "Rajasthan FSO — Full Access",
      productType: "EXAM_ACCESS",
      examId: fso.id,
      accessType: "PAID",
      isActive: true,
      isVisible: false,
      purchaseEnabled: false,
      couponsAllowed: false,
      mrpPaise: 20000,
      sellingPricePaise: 20000,
      accessDurationType: "FIXED_DATE",
      accessExpiresAt: null,
    },
  });
  console.log(`FSO fixture: exam ${fso.id}, 2 papers (2019: 150, 2022: 150 stored), 4 coupons, hidden ₹200 product.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
