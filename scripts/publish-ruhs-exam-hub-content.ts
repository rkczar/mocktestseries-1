/**
 * One-off: publish researched RUHS Medical Officer 2026 Exam Hub content to
 * the canonical Exam row (the same fields Admin → Exams → Edit writes:
 * SEO title/description, short description, overview, eligibility, pattern
 * note, important dates, FAQ). Admins keep editing them there afterwards.
 *
 * Every fact is from an official RUHS document (sources in the SEO report
 * under /var/log/mocktestseries/ruhs-seo-phase2-*.md):
 *   - Recruitment notification MODRE-2026, ref. 2026/1173 dated 13/08/2026
 *     (ruhsraj.org/cms/uploads/2026/08/MO_600_2435.pdf): 600 posts, category
 *     split, form + booklet 14/09/2026–13/10/2026, MBBS + RMC by exam date.
 *   - RUHS MO (Medical) 2026 application instructions (ruhsmomedical.com,
 *     linked from ruhsraj.org): RMC certificate upload within 2 days after
 *     the exam when not available while applying.
 *   - MODRE-2024 instructions to candidates and notice dated 21/04/2025:
 *     held 27/04/2025, offline OMR, 100 MCQs, 120 minutes, no negative marking.
 * Not verifiable from a public official page, so stated as tentative or left
 * to the booklet: the 2026 exam date and the age limit.
 *
 *   npx tsx scripts/publish-ruhs-exam-hub-content.ts            # dry run
 *   npx tsx scripts/publish-ruhs-exam-hub-content.ts --apply    # write
 *
 * Writes a JSON backup of the previous values next to the report first.
 * Only presentation fields of one Exam row change; no product, price,
 * order, payment, entitlement, student, attempt or question row is written.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");
const EXAM_CODE = "RUHSMO";
const LOG_DIR = "/var/log/mocktestseries";

const CONTENT = {
  examMode: "Offline (OMR-based)",
  seoTitle: "RUHS Medical Officer 2026: Notification, Exam Pattern, Syllabus & PYQs",
  seoDescription:
    "Rajasthan Medical Officer exam 2026 (RUHS MODRE-2026): 600 posts, applications 14 Sep–13 Oct 2026. Eligibility, pattern, syllabus, previous papers and mock tests.",
  shortDescription:
    "RUHS has notified 600 Medical Officer (Medical) posts under MODRE-2026. Check the key dates, eligibility and exam pattern, then prepare with previous year papers, subject-wise practice and timed mock tests.",
  overview: [
    "Rajasthan University of Health Sciences (RUHS), Jaipur, has notified the Medical Officer Direct Recruitment Examination 2026 (MODRE-2026) for 600 posts of Medical Officer (Medical) under the Rajasthan Medical Services Rules, 1963, in the Medical, Health & Family Welfare Department, Government of Rajasthan. The recruitment notification is dated 13 August 2026.",
    "Posts by category: UR 216, BC 126, SC 96, ST 72, EWS 60 and MBC 30.",
    "The online application form and the detailed Information Booklet are available from 14 September to 13 October 2026. The booklet sets out eligibility, reservation, pay and the examination schedule. Read it on the official RUHS website (ruhsraj.org), which links to the recruitment portal, before you apply.",
  ].join("\n\n"),
  eligibility: [
    "Essential qualification: MBBS.",
    "Permanent registration with the Rajasthan Medical Council (RMC) is mandatory, issued on or before the date of the written examination. If the permanent RMC certificate is not available while you fill the form, the application instructions require it to be uploaded within 2 days after the examination.",
    "Age limit, relaxations and the remaining conditions are given in the official Information Booklet. Check them there; this page does not restate figures that could not be confirmed from a public official document.",
  ].join("\n\n"),
  examPatternInfo:
    "The 2026 Information Booklet is the authority for this year's pattern. For reference, in the previous cycle (MODRE-2024, held on 27 April 2025) RUHS's instructions to candidates described an offline, OMR-based paper of 100 multiple-choice questions with four options each, to be attempted in 120 minutes, with no negative marking. Past papers have drawn questions from across the MBBS curriculum.",
  importantDates: [
    { label: "Recruitment notification", date: "13 August 2026" },
    { label: "Online application and Information Booklet", date: "14 September – 13 October 2026" },
    { label: "Written examination", date: "13 December 2026 (tentative; confirm on ruhsraj.org and your admit card)" },
    { label: "Admit card", date: "To be announced by RUHS" },
  ],
  faqItems: [
    {
      question: "How many posts are there in RUHS Medical Officer 2026?",
      answer:
        "600 posts of Medical Officer (Medical): UR 216, BC 126, SC 96, ST 72, EWS 60 and MBC 30, as per the RUHS recruitment notification dated 13 August 2026.",
    },
    {
      question: "When can I apply for RUHS MO 2026?",
      answer:
        "The online application form and the Information Booklet are available from 14 September to 13 October 2026 through the official RUHS website, ruhsraj.org.",
    },
    {
      question: "What qualification do I need?",
      answer:
        "An MBBS degree, and permanent Rajasthan Medical Council (RMC) registration issued on or before the date of the written examination. Age limit and other conditions are in the official Information Booklet.",
    },
    {
      question: "When is the RUHS MO 2026 exam?",
      answer:
        "The written examination is expected on 13 December 2026. Treat this as tentative until RUHS confirms it on ruhsraj.org and on your admit card.",
    },
    {
      question: "What was the exam pattern in the last cycle?",
      answer:
        "MODRE-2024, held on 27 April 2025, was an offline OMR-based paper of 100 multiple-choice questions (four options each) in 120 minutes, with no negative marking. Check the 2026 Information Booklet for this year's pattern.",
    },
    {
      question: "Why is the 2024 exam sometimes called the 2025 paper?",
      answer:
        "The Medical Officer Direct Recruitment Examination 2024 (MODRE-2024) was postponed and held on 27 April 2025, so the same paper is searched under both years.",
    },
    {
      question: "Is Mock Test Series connected with RUHS?",
      answer:
        "No. Mock Test Series is an independent exam-preparation platform and is not affiliated with RUHS or the Government of Rajasthan. For official notices, always refer to ruhsraj.org.",
    },
  ],
} as const;

type Field = keyof typeof CONTENT;

async function main() {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { code: EXAM_CODE } });
  if (!exam.publicPageEnabled || !exam.publicSlug) throw new Error(`${EXAM_CODE} has no public page`);

  const fields = Object.keys(CONTENT) as Field[];
  const before = Object.fromEntries(fields.map((f) => [f, exam[f]]));
  const changed = fields.filter((f) => JSON.stringify(exam[f]) !== JSON.stringify(CONTENT[f]));
  console.log(`${exam.name} (${exam.publicSlug}): ${changed.length} field(s) to update: ${changed.join(", ") || "none"}`);
  for (const f of changed) console.log(`  ${f}:\n    before: ${JSON.stringify(exam[f])}\n    after:  ${JSON.stringify(CONTENT[f])}`);

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply.");
    return;
  }
  if (changed.length === 0) return;

  mkdirSync(LOG_DIR, { recursive: true });
  const backup = `${LOG_DIR}/ruhs-exam-hub-content-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(backup, JSON.stringify({ examId: exam.id, code: EXAM_CODE, updatedAt: exam.updatedAt, before }, null, 2));
  console.log(`Backup of previous values: ${backup}`);

  await prisma.$transaction([
    prisma.exam.update({
      where: { id: exam.id },
      data: Object.fromEntries(changed.map((f) => [f, CONTENT[f]])),
    }),
    prisma.auditLog.create({
      data: {
        actorId: null,
        action: "EXAM_PUBLIC_CONTENT_UPDATED",
        entityType: "Exam",
        entityId: exam.id,
        metadata: { via: "scripts/publish-ruhs-exam-hub-content.ts", fields: changed, backup },
      },
    }),
  ]);
  console.log("Applied.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
