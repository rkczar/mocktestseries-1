/**
 * Rajasthan FSO configuration for a separately approved production step. DRY RUN by default: prints
 * every field it would change (before → after) and exits. With --apply it writes, in one transaction:
 *   - Exam RUHS-FSO: negativeMarking = 1/3, BILINGUAL, conducting authority, 150 Q / 150 marks,
 *     publicSlug, SEO + editorial drafts (official facts only). NEVER isActive / publicPageEnabled.
 *   - PreviousYearPaper 2019 / 2022: durationMinutes 180 / 150, heldOn 25-11-2019 / 27-06-2023.
 *   - Product rpsc-fso-full-access (₹200 GST-inclusive, EXAM_ACCESS, hidden, purchase disabled,
 *     couponsAllowed=false, FIXED_DATE with NO date — an admin sets the date from the official exam date).
 *   - Setting exam.features.<FSO> = both downloads OFF (explicit).
 * It never reads or writes a Question row (the 7 deleted-key questions stay as they are), never
 * changes RUHS MO, coupons, the default exam or any other exam.
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=… npx tsx scripts/fso-setup.ts            # dry run
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=… npx tsx scripts/fso-setup.ts --apply    # approved only
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { FSO_EXAM_CODE } from "@/lib/exam-downloads";
import { FSO_PAPERS } from "@/lib/fso-official";
import { examFeaturesKey } from "@/lib/exam-features";

export const FSO_PRODUCT_CODE = "rpsc-fso-full-access";
export const FSO_PUBLIC_SLUG = "rajasthan-food-safety-officer";

export const FSO_EXAM_FIELDS = {
  negativeMarking: 1 / 3,
  languageMode: "BILINGUAL" as const,
  conductingAuthority: "Rajasthan Public Service Commission (RPSC), Ajmer",
  totalQuestions: 150,
  totalMarks: 150,
  publicSlug: FSO_PUBLIC_SLUG,
  shortDescription: "RPSC Food Safety Officer: both previous papers (2019, 2022) in Hindi and English with official answer keys.",
  seoTitle: "Rajasthan FSO (RPSC Food Safety Officer) Previous Papers & Tests",
  seoDescription:
    "RPSC Food Safety Officer: 2019 and 2022 papers in Hindi and English with RPSC answer keys, syllabus, eligibility and exam pattern from official notices.",
  overview:
    "Food Safety Officer posts of the Rajasthan Medical and Health Services Department are filled by the Rajasthan Public Service Commission (RPSC), Ajmer. RPSC has held two FSO examinations: the 2019 Screening Test (25-11-2019) and the 2022 Competitive Exam (27-06-2023). No newer FSO advertisement has been published by RPSC as of 12 November 2026.",
  eligibility:
    "As per RPSC Advertisement No. 11/2022-23: a degree in Food Technology, Dairy Technology, Biotechnology, Oil Technology, Agriculture Science, Veterinary Sciences, Bio-Chemistry or Microbiology, a Master's degree in Chemistry or a degree in Medicine (or an equivalent qualification notified by the Central Government); working knowledge of Hindi in Devanagari and knowledge of Rajasthan culture. Age 18 to below 40 years on 01-01-2023, with category relaxations. See the Eligibility page for the exact wording.",
  examPatternInfo:
    "2022 (Advt. 11/2022-23): one paper, 150 questions, 150 marks, 2 hours 30 minutes; Part A General Knowledge of Rajasthan 40 questions, Part B Concerned Subject 110 questions; one-third negative marking (incorrect or multiple answers).\n2019 Screening Test: 150 questions, 150 marks, 3 hours, one-third negative marking, followed by an interview.\nOptions are numbered 1–4 and the booklet is bilingual (the English version prevails). A future advertisement may change the pattern.",
};

const PAPER_FIELDS = Object.values(FSO_PAPERS).map((p) => {
  const [d, m, y] = p.heldOn.split("-").map(Number);
  return { year: p.year, durationMinutes: p.durationMinutes, heldOn: new Date(Date.UTC(y, m - 1, d)) };
});

const show = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v.length > 60 ? `${v.slice(0, 57)}…` : JSON.stringify(v));

async function main() {
  const apply = process.argv.includes("--apply");
  const exam = await prisma.exam.findUnique({ where: { code: FSO_EXAM_CODE } });
  if (!exam) throw new Error(`Exam ${FSO_EXAM_CODE} not found.`);
  if (exam.isActive || exam.publicPageEnabled) console.log(`NOTE: exam is already isActive=${exam.isActive} publicPageEnabled=${exam.publicPageEnabled}; this script never changes either.`);
  const slugOwner = await prisma.exam.findFirst({ where: { publicSlug: FSO_PUBLIC_SLUG, id: { not: exam.id } }, select: { code: true } });
  if (slugOwner) throw new Error(`publicSlug ${FSO_PUBLIC_SLUG} already belongs to ${slugOwner.code}.`);

  console.log(`Exam ${exam.code} (${exam.id}) — ${apply ? "APPLY" : "DRY RUN"}`);
  const examChanges: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(FSO_EXAM_FIELDS)) {
    const before = (exam as Record<string, unknown>)[k];
    if (before !== v) {
      examChanges[k] = v;
      console.log(`  exam.${k}: ${show(before)} → ${show(v)}`);
    }
  }
  const papers = await prisma.previousYearPaper.findMany({ where: { examId: exam.id }, select: { id: true, year: true, durationMinutes: true, heldOn: true } });
  const paperChanges = PAPER_FIELDS.flatMap((f) => {
    const p = papers.find((x) => x.year === f.year);
    if (!p) {
      console.log(`  paper ${f.year}: MISSING (skipped)`);
      return [];
    }
    const data: Prisma.PreviousYearPaperUpdateInput = {};
    if (p.durationMinutes !== f.durationMinutes) data.durationMinutes = f.durationMinutes;
    if (p.heldOn?.getTime() !== f.heldOn.getTime()) data.heldOn = f.heldOn;
    if (Object.keys(data).length) console.log(`  paper ${f.year}: ${show(p.durationMinutes)}/${show(p.heldOn)} → ${f.durationMinutes}/${show(f.heldOn)}`);
    return Object.keys(data).length ? [{ id: p.id, data }] : [];
  });
  const product = await prisma.product.findUnique({ where: { code: FSO_PRODUCT_CODE } });
  console.log(product ? `  product ${FSO_PRODUCT_CODE}: exists (left unchanged)` : `  product ${FSO_PRODUCT_CODE}: create (₹200, hidden, purchase disabled, coupons off, fixed date unset)`);
  const featuresKey = examFeaturesKey(exam.id);
  const features = await prisma.setting.findUnique({ where: { key: featuresKey } });
  console.log(features ? `  ${featuresKey}: exists (left unchanged) ${JSON.stringify(features.value)}` : `  ${featuresKey}: create {omrDownloadEnabled:false, paperDownloadEnabled:false}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply after approval.");
    return;
  }
  await prisma.$transaction(async (tx) => {
    if (Object.keys(examChanges).length) await tx.exam.update({ where: { id: exam.id }, data: examChanges });
    for (const c of paperChanges) await tx.previousYearPaper.update({ where: { id: c.id }, data: c.data });
    if (!product)
      await tx.product.create({
        data: {
          code: FSO_PRODUCT_CODE,
          name: "Rajasthan FSO — Full Access",
          description: "All Rajasthan FSO previous year papers (2019, 2022), tests and paper PDFs. ₹200 including GST.",
          productType: "EXAM_ACCESS",
          examId: exam.id,
          accessType: "PAID",
          isActive: true,
          isVisible: false,
          purchaseEnabled: false,
          couponsAllowed: false,
          mrpPaise: 20000,
          sellingPricePaise: 20000,
          saleEnabled: false,
          accessDurationType: "FIXED_DATE",
          accessExpiresAt: null,
        },
      });
    if (!features)
      await tx.setting.create({ data: { key: featuresKey, value: { omrDownloadEnabled: false, paperDownloadEnabled: false, updatedBy: "scripts/fso-setup.ts" } } });
    await tx.auditLog.create({
      data: { action: "FSO_SETUP_APPLIED", entityType: "Exam", entityId: exam.id, metadata: { examFields: Object.keys(examChanges), papers: paperChanges.length, productCreated: !product, featuresCreated: !features } as Prisma.InputJsonValue },
    });
  });
  console.log("Applied.");
}

if (process.argv[1] && /fso-setup\.ts$/.test(process.argv[1])) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
