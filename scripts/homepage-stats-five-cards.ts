/**
 * One-off content update: the homepage Platform Stats section → exactly the
 * 5 owner-specified cards (Total Students, Tests Attempted, Questions
 * Attempted, Questions Available, AI Explanations Used), in that order.
 *
 * Touches ONLY the STATISTICS section of the PUBLISHED and DRAFT homepage
 * configs. Every existing card keeps its mode (LIVE / CUSTOM), custom value,
 * icon, format and suffix — admin overrides are preserved; only the data
 * source of two cards moves to its corrected definition
 * (Tests Attempted → testsStarted, Questions Available → questionsAvailable).
 *
 *   npx tsx scripts/homepage-stats-five-cards.ts            # dry run (prints before/after)
 *   npx tsx scripts/homepage-stats-five-cards.ts --apply BACKUP_DIR=/path  # writes, after saving a JSON backup
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeStatMetrics, type StatMetric } from "@/lib/homepage-field-codec";
import { DEFAULT_STAT_METRICS } from "@/lib/homepage-sections";
import { validateStatisticsMetrics } from "@/lib/homepage-stat-sanitize";

const TARGET = DEFAULT_STAT_METRICS.map((d) => ({ ...d })) as unknown as StatMetric[];

export function toFiveCards(current: StatMetric[]): StatMetric[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  return TARGET.map((d) => {
    const existing = byId.get(d.id);
    if (!existing) return { ...d };
    return {
      ...existing,
      label: d.label,
      dynamicKey: d.dynamicKey,
      enabled: true,
      icon: existing.icon ?? d.icon,
      format: existing.format ?? d.format,
      suffix: existing.suffix ?? d.suffix,
    };
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.homepageSection.findMany({
    where: { key: "STATISTICS", homepageConfig: { status: { in: ["PUBLISHED", "DRAFT"] } } },
    select: { id: true, content: true, homepageConfig: { select: { status: true, version: true } } },
  });
  const backup = [];
  for (const row of rows) {
    const content = (row.content ?? {}) as Record<string, unknown>;
    const before = normalizeStatMetrics(content.metrics);
    const after = toFiveCards(before);
    const invalid = validateStatisticsMetrics(after);
    if (invalid) throw new Error(`${row.homepageConfig.status}: ${invalid}`);
    console.log(`\n${row.homepageConfig.status} v${row.homepageConfig.version} (${row.id})`);
    console.log("  before:", before.map((m) => `${m.label}[${m.mode}${m.mode === "MANUAL" ? `=${m.manualValue}` : ""}:${m.dynamicKey}]`).join(" | "));
    console.log("  after: ", after.map((m) => `${m.label}[${m.mode}${m.mode === "MANUAL" ? `=${m.manualValue}` : ""}:${m.dynamicKey}]`).join(" | "));
    backup.push({ id: row.id, status: row.homepageConfig.status, content: row.content, next: { ...content, metrics: after } });
  }
  if (apply) {
    const dir = process.env.BACKUP_DIR;
    if (!dir) throw new Error("BACKUP_DIR is required with --apply");
    // Backup first: nothing is written unless the previous content is safely on disk.
    const file = path.join(dir, `homepage-statistics-before-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(backup, null, 2));
    await prisma.$transaction(backup.map((b) => prisma.homepageSection.update({ where: { id: b.id }, data: { content: b.next as unknown as Prisma.InputJsonValue } })));
    console.log(`\nAPPLIED to ${rows.length} section(s). Backup: ${file}`);
  } else {
    console.log("\nDry run — nothing written.");
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("homepage-stats-five-cards.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
