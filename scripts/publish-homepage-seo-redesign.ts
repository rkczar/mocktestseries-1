/**
 * One-off: publish the homepage SEO / free-first redesign content (keyword
 * map and copy in /var/log/mocktestseries/homepage-seo-redesign-*.md).
 *
 * Goes through the same path as Admin → Website → Homepage: edits the
 * current DRAFT (getOrCreateDraft also appends the new FREE_START /
 * EXAM_GUIDE / FAQ sections), then archives the PUBLISHED version and
 * publishes the draft in one transaction, with an audit-log row. Every
 * earlier version stays restorable from Version History.
 *
 * Safety: refuses to run if the draft holds unpublished admin edits in any
 * section other than STATISTICS (those are the stats-card changes this
 * redesign supersedes) unless --force is passed. --dry-run prints the plan
 * and changes nothing.
 *
 * Run AFTER the code that renders the new sections is deployed (the old
 * release can't read the new section keys):
 *
 *   npx tsx scripts/publish-homepage-seo-redesign.ts --dry-run
 *   npx tsx scripts/publish-homepage-seo-redesign.ts
 *
 * Only presentation content changes. No product, price, order, payment,
 * entitlement, student, attempt or question row is read for writing.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getOrCreateDraft } from "@/lib/homepage";
import { sanitizeStatisticsContent } from "@/lib/homepage-stat-sanitize";
import type { Prisma } from "@prisma/client";
import { ORDER, SEO, plan, REDESIGN_EXAM_CODE as EXAM_CODE } from "./homepage-seo-redesign-content";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const json = (v: unknown) => JSON.stringify(v ?? null);

async function main() {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { code: EXAM_CODE } });
  if (!exam.publicSlug || !exam.publicPageEnabled || !exam.isActive) throw new Error(`${EXAM_CODE} has no live public page`);

  const published = await prisma.homepageConfig.findFirst({
    where: { status: "PUBLISHED" },
    include: { sections: true },
    orderBy: { version: "desc" },
  });
  const draft = await getOrCreateDraft();

  // Unpublished admin edits we'd silently ship or overwrite?
  const unexpected = draft.sections.filter((d) => {
    if (d.key === "STATISTICS") return false;
    const p = published?.sections.find((x) => x.key === d.key);
    if (!p) return false; // newly appended section
    return json(p.content) !== json(d.content) || json(p.references) !== json(d.references) || p.isEnabled !== d.isEnabled;
  });
  if (unexpected.length > 0 && !FORCE) {
    throw new Error(`Draft v${draft.version} has unpublished edits in: ${unexpected.map((s) => s.key).join(", ")}. Review them in Admin, or re-run with --force.`);
  }

  const target = plan(exam.id, exam.publicSlug);
  const updates = draft.sections.map((section) => {
    const p = target[section.key];
    const order = ORDER.indexOf(section.key);
    let content = p?.content ? { ...(section.content as Record<string, unknown>), ...p.content } : (section.content as Record<string, unknown>);
    if (section.key === "STATISTICS") content = sanitizeStatisticsContent(content);
    return {
      id: section.id,
      key: section.key,
      isEnabled: p?.enabled ?? section.isEnabled,
      order: order >= 0 ? order : 100 + section.order,
      content,
      references: p?.references ? { ...((section.references as Record<string, unknown>) ?? {}), ...p.references } : section.references,
    };
  });

  console.log(`Draft v${draft.version} → publish (was v${published?.version ?? "none"})`);
  for (const u of [...updates].sort((a, b) => a.order - b.order)) console.log(`  ${String(u.order).padStart(3)}  ${u.isEnabled ? "on " : "off"}  ${u.key}`);
  console.log(`  SEO title: ${SEO.title} (${SEO.title.length} chars)`);
  console.log(`  SEO description: ${SEO.metaDescription.length} chars`);
  if (DRY_RUN) {
    console.log("Dry run — nothing written.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      await tx.homepageSection.update({
        where: { id: u.id },
        data: {
          isEnabled: u.isEnabled,
          order: u.order,
          content: u.content as Prisma.InputJsonValue,
          references: (u.references ?? {}) as Prisma.InputJsonValue,
        },
      });
    }
    const seo = { ...((draft.seo as Record<string, unknown>) ?? {}), ...SEO };
    await tx.homepageConfig.update({ where: { id: draft.id }, data: { seo: seo as Prisma.InputJsonValue } });
    await tx.homepageConfig.updateMany({ where: { status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    await tx.homepageConfig.update({ where: { id: draft.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "HOMEPAGE_PUBLISHED",
        entityType: "HomepageConfig",
        entityId: draft.id,
        metadata: {
          version: draft.version,
          previousVersion: published?.version ?? null,
          via: "scripts/publish-homepage-seo-redesign.ts",
          summary: "Homepage SEO / free-first redesign: new IA, Start for Free, exam guide, FAQ, 4 live stats",
        },
      },
    });
  });
  console.log(`Published HomepageConfig v${draft.version}. Previous v${published?.version ?? "none"} is archived and restorable.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
