/**
 * One-off data update (2026-10-05): RUHS Medical Officer 2026 Previous Year
 * Papers → PreviousYearPaper.durationMinutes = 120.
 *
 * Touches ONLY the 9 PreviousYearPaper rows listed below, inside one
 * transaction, and only if every guard holds (exam id + code, exactly these 9
 * paper ids, nothing else under the exam). TestAttempt, Question, options and
 * mappings are never written; attempts keep their frozen durationMinutes.
 *
 *   npx tsx scripts/set-ruhs-mo-pyq-duration.ts            # dry run (read-only)
 *   npx tsx scripts/set-ruhs-mo-pyq-duration.ts --apply    # write
 * (on the production DB both need ALLOW_PRODUCTION_DB=1)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const RUHS_MO_EXAM_ID = "cmu1joakv000kwnkzjb2hdy1u";
const RUHS_MO_EXAM_CODE = "RUHSMO";
const TARGET_MINUTES = 120;
const PAPER_IDS = [
  "cmu9wgj7h00012qkzp4od5scz", // RUHS MO 2024
  "cmu9x7dle006y2qkzbce7cqwz", // RUHS MO 2022
  "cmu9xfgjz00ku2qkzu0dew2kd", // RUHS MO 2020
  "cmu9xi81200ns2qkzmnxkftvx", // RUHS MO 2019
  "cmu9xq1j800nz2qkzor1yl7aw", // RUHS MO 2018
  "cmu9xwhu501vm2bkz47xxv4cw", // RUHS MO 2017
  "cmu9yhndo01md2qkzueyfhsao", // RUHS MO 2016
  "cmu9ymoxh02072qkzn37zg6e9", // RUHS MO 2015
  "cmu9yqm6k02ie2bkzkbgv1cd3", // RUHS MO 2013
];

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("This targets the production database: set ALLOW_PRODUCTION_DB=1 to confirm.");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function stop(reason: string): never {
  throw new Error(`STOP — no data changed: ${reason}`);
}

async function main() {
  await prisma.$transaction(async (tx) => {
    const exam = await tx.exam.findUnique({ where: { id: RUHS_MO_EXAM_ID }, select: { id: true, code: true, name: true, durationMinutes: true } });
    if (!exam || exam.code !== RUHS_MO_EXAM_CODE) stop(`exam ${RUHS_MO_EXAM_ID} missing or code is not ${RUHS_MO_EXAM_CODE}`);
    console.log(`Exam: ${exam.name} (id ${exam.id}, code ${exam.code}, Exam.durationMinutes ${exam.durationMinutes ?? "NULL"})`);

    const papers = await tx.previousYearPaper.findMany({
      where: { examId: exam.id },
      select: { id: true, year: true, title: true, durationMinutes: true },
      orderBy: { year: "desc" },
    });
    for (const p of papers) {
      const effective = p.durationMinutes ?? exam.durationMinutes ?? 60; // what the engine used BEFORE this change
      console.log(`  ${p.id} | ${p.year} | ${p.title} | stored ${p.durationMinutes ?? "NULL"} | old effective ${effective} min`);
    }
    const ids = papers.map((p) => p.id).sort();
    if (papers.length !== 9) stop(`expected exactly 9 papers under the exam, found ${papers.length}`);
    if (JSON.stringify(ids) !== JSON.stringify([...PAPER_IDS].sort())) stop("paper ids under the exam differ from the reviewed list");

    if (!apply) {
      console.log("\nDry run: nothing written. Re-run with --apply to set durationMinutes = 120 on these 9 papers.");
      return;
    }
    const { count } = await tx.previousYearPaper.updateMany({
      where: { id: { in: PAPER_IDS }, examId: exam.id },
      data: { durationMinutes: TARGET_MINUTES },
    });
    if (count !== 9) stop(`updateMany matched ${count} rows, expected 9 (rolled back)`);
    const after = await tx.previousYearPaper.findMany({ where: { id: { in: PAPER_IDS } }, select: { durationMinutes: true } });
    if (after.some((p) => p.durationMinutes !== TARGET_MINUTES)) stop("post-update read-back mismatch (rolled back)");
    console.log(`\nUpdated PreviousYearPaper rows: ${count} (durationMinutes = ${TARGET_MINUTES}). No other table written.`);
  });
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
