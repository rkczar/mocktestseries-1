/**
 * One-off content update: add a "Plans & Pricing" → /plans-and-pricing link to
 * the site header nav and the footer links.
 *
 * Touches ONLY the HEADER and FOOTER sections of the PUBLISHED and DRAFT
 * homepage configs (no full draft publish, so no other draft edits go live).
 * Idempotent: a section that already links to /plans-and-pricing is left as is.
 *
 *   npx tsx scripts/homepage-plans-pricing-links.ts            # dry run (prints before/after)
 *   npx tsx scripts/homepage-plans-pricing-links.ts --apply BACKUP_DIR=/path  # writes, after saving a JSON backup
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const HREF = "/plans-and-pricing";
type Pair = [string, string];

/** Inserts [label, HREF] right after the pair whose href is `afterHref` (or at the end). */
export function withLink(pairs: Pair[], label: string, afterHref: string): Pair[] {
  if (pairs.some(([, href]) => href === HREF)) return pairs;
  const at = pairs.findIndex(([, href]) => href === afterHref);
  const next = [...pairs];
  next.splice(at === -1 ? next.length : at + 1, 0, [label, HREF]);
  return next;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.homepageSection.findMany({
    where: { key: { in: ["HEADER", "FOOTER"] }, homepageConfig: { status: { in: ["PUBLISHED", "DRAFT"] } } },
    select: { id: true, key: true, content: true, homepageConfig: { select: { status: true, version: true } } },
  });
  const backup = [];
  for (const row of rows) {
    const content = (row.content ?? {}) as Record<string, unknown>;
    const field = row.key === "HEADER" ? "navItems" : "links";
    const before = (Array.isArray(content[field]) ? content[field] : []) as Pair[];
    const after =
      row.key === "HEADER"
        ? withLink(before, "Plans & Pricing", "/exams/rajasthan-medical-officer/previous-year-papers")
        : withLink(before, "RUHS MO Plans & Pricing", "/exams/rajasthan-medical-officer/mock-test-series");
    console.log(`\n${row.homepageConfig.status} v${row.homepageConfig.version} ${row.key} (${row.id})`);
    console.log("  before:", before.map(([l]) => l).join(" | "));
    console.log("  after: ", after.map(([l]) => l).join(" | "));
    if (after !== before) backup.push({ id: row.id, key: row.key, status: row.homepageConfig.status, content: row.content, next: { ...content, [field]: after } });
  }
  if (apply && backup.length) {
    const dir = process.env.BACKUP_DIR;
    if (!dir) throw new Error("BACKUP_DIR is required with --apply");
    // Backup first: nothing is written unless the previous content is safely on disk.
    const file = path.join(dir, `homepage-header-footer-before-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(backup, null, 2));
    await prisma.$transaction(backup.map((b) => prisma.homepageSection.update({ where: { id: b.id }, data: { content: b.next as unknown as Prisma.InputJsonValue } })));
    console.log(`\nAPPLIED to ${backup.length} section(s). Backup: ${file}`);
  } else {
    console.log(apply ? "\nNothing to change." : "\nDry run — nothing written.");
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("homepage-plans-pricing-links.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
