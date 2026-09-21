/**
 * One-off script: publish the homepage content decided in the launch review
 * (platform-wide hero, RUHS MO featured now). Edits the current DRAFT
 * HomepageConfig's HERO / FEATURED_EXAM / UPCOMING_EXAMS sections, then
 * publishes it — mirroring app/admin/(dashboard)/website/homepage/actions.ts
 * publishHomepageAction() so this goes through the same archive-then-publish
 * transaction the admin UI uses. Run once; safe to re-run (idempotent on the
 * content it sets, though re-running will bump the version again).
 *
 * Deliberately does NOT enable Exam.publicPageEnabled or populate the new
 * public-exam-page marketing fields (eligibility, examPatternInfo, FAQs,
 * etc.) for RUHS MO — those are real government-exam facts that need a
 * human source, not a script. Also does NOT lead with a "Take Mock Test" CTA
 * since RUHS MO currently has zero published mock tests (914 questions / 20
 * subjects / 9 previous year papers exist, but no mock test yet) — that CTA
 * stays generic ("View Details") to avoid promising content that isn't live.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getOrCreateDraft } from "@/lib/homepage";
import type { Prisma } from "@prisma/client";

const RUHS_MO_EXAM_ID = "cmu1joakv000kwnkzjb2hdy1u";

async function main() {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: RUHS_MO_EXAM_ID } });
  console.log(`Featuring exam: ${exam.name} (${exam.id})`);

  const draft = await getOrCreateDraft();
  const sectionByKey = new Map(draft.sections.map((s) => [s.key, s]));

  const hero = sectionByKey.get("HERO");
  const featured = sectionByKey.get("FEATURED_EXAM");
  const upcoming = sectionByKey.get("UPCOMING_EXAMS");
  if (!hero || !featured || !upcoming) {
    throw new Error("Draft is missing HERO/FEATURED_EXAM/UPCOMING_EXAMS sections");
  }

  await prisma.$transaction(async (tx) => {
    // HERO: drop the single-exam "NTA NEET UG 2027" branding for a
    // platform-wide message (matches the SEO copy already updated in
    // lib/homepage.ts). Anchors/CTAs unchanged.
    await tx.homepageSection.update({
      where: { id: hero.id },
      data: {
        content: {
          ...(hero.content as Record<string, unknown>),
          eyebrow: "",
          heading: "Master your target exam with realistic mock tests",
          description:
            "Full-length mock tests, previous year papers, and AI-powered explanations — everything you need in one platform.",
        } as Prisma.InputJsonValue,
      },
    });

    // FEATURED_EXAM: point at RUHS MO. Description uses real, current DB
    // counts (914 questions / 20 subjects / 9 previous year papers) instead
    // of inventing marketing copy. CTA stays "View Details" rather than
    // "Take Mock Test" since none is published yet.
    await tx.homepageSection.update({
      where: { id: featured.id },
      data: {
        content: {
          ...(featured.content as Record<string, unknown>),
          description: "914 questions across 20 subjects, plus 9 years of previous year papers.",
        } as Prisma.InputJsonValue,
        references: { examId: RUHS_MO_EXAM_ID } as Prisma.InputJsonValue,
      },
    });

    // UPCOMING_EXAMS: RUHS MO has a real upcomingDate (2026-12-13) to count
    // down to.
    await tx.homepageSection.update({
      where: { id: upcoming.id },
      data: {
        content: {
          ...(upcoming.content as Record<string, unknown>),
          exams: [{ id: crypto.randomUUID(), examId: RUHS_MO_EXAM_ID, enabled: true }],
        } as Prisma.InputJsonValue,
      },
    });

    await tx.homepageConfig.updateMany({ where: { status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    await tx.homepageConfig.update({
      where: { id: draft.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "HOMEPAGE_PUBLISHED",
        entityType: "HomepageConfig",
        entityId: draft.id,
        metadata: {
          version: draft.version,
          via: "scripts/publish-ruhs-homepage-launch.ts",
          summary: "Platform-wide hero + RUHS MO featured/upcoming",
        },
      },
    });
  });

  console.log(`Published HomepageConfig version ${draft.version}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
