/**
 * Idempotent payment-launch update of the admin-managed legal content
 * (Admin → Website → Homepage → Contact / About / Legal + Footer), on both
 * the PUBLISHED and the DRAFT homepage configs — same pattern as
 * scripts/backfill-communications-content.ts.
 *
 *  - Terms / Privacy: a document that still contains its original
 *    pre-payments placeholder paragraph ("does not currently charge /
 *    process payments … [Requires owner/legal review …]") is replaced by the
 *    complete payment-capable version — but ONLY if every other line of the
 *    stored text is carried over into the new version. If an admin has
 *    written anything the new version would drop, the document is skipped
 *    and the lost lines are listed.
 *  - Refund & Cancellation Policy: seeded only when empty.
 *  - Footer: adds a "Refund & Cancellation Policy" link when missing.
 *
 * A document without the placeholder (already migrated or edited by an
 * admin) is never touched. The previous content of every touched section is
 * written to a JSON backup first. Owner review (Live Launch Readiness) is
 * tied to the text hash, so updated documents always need a fresh review.
 * Copy: lib/legal-payment-copy.ts.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/apply-payment-legal-content.ts [--dry-run]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";

/** Sentences of `before` (minus the legacy placeholder and "## " headings) that don't survive word-for-word into `after`. */
function droppedLines(before: string, legacyBlock: string, after: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(after);
  return before
    .replace(legacyBlock, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("## "))
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => norm(s).replace(/[.:]$/, ""))
    .filter(Boolean)
    .filter((s) => !target.includes(s));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { prisma } = await import("../lib/prisma");
  const copy = await import("../lib/legal-payment-copy");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  const configs = await prisma.homepageConfig.findMany({
    where: { status: { in: ["PUBLISHED", "DRAFT"] } },
    include: { sections: { where: { key: { in: ["CONTACT_INFO", "FOOTER"] } } } },
  });
  const backup: unknown[] = [];
  const updates: { id: string; content: Record<string, unknown>; label: string; changes: string[] }[] = [];
  let blocked = false;

  for (const cfg of configs) {
    for (const section of cfg.sections) {
      const label = `${cfg.status} v${cfg.version} ${section.key}`;
      const before = (section.content ?? {}) as Record<string, unknown>;
      const next = { ...before };
      const changes: string[] = [];
      if (section.key === "CONTACT_INFO") {
        const docs = [
          { name: "terms", body: "termsBody", updated: "termsLastUpdated", legacy: copy.LEGACY_TERMS_PAYMENT_BLOCK, full: copy.TERMS_DOCUMENT },
          { name: "privacy", body: "privacyBody", updated: "privacyLastUpdated", legacy: copy.LEGACY_PRIVACY_PAYMENT_BLOCK, full: copy.PRIVACY_DOCUMENT },
        ];
        for (const d of docs) {
          const cur = typeof before[d.body] === "string" ? (before[d.body] as string) : "";
          if (!cur.includes(d.legacy)) continue;
          const lost = droppedLines(cur, d.legacy, d.full);
          if (lost.length) {
            blocked = true;
            console.log(`${label}: SKIPPED ${d.name} — these existing lines are not in the new version:\n  - ${lost.join("\n  - ")}`);
            continue;
          }
          next[d.body] = d.full;
          next[d.updated] = today;
          changes.push(`${d.name} → complete payment-capable version`);
        }
        if (!(typeof before.refundBody === "string" && before.refundBody.trim())) {
          next.refundBody = copy.REFUND_POLICY_DOCUMENT;
          next.refundLastUpdated = today;
          changes.push("refund & cancellation policy");
        }
      } else if (section.key === "FOOTER" && Array.isArray(before.links)) {
        const links = before.links as [string, string][];
        if (!links.some((l) => l?.[1] === "/refund-policy")) {
          const at = links.findIndex((l) => l?.[1] === "/contact");
          const out = [...links];
          out.splice(at >= 0 ? at : out.length, 0, ["Refund & Cancellation Policy", "/refund-policy"]);
          next.links = out;
          changes.push("footer refund link");
        }
      }
      if (changes.length) {
        backup.push({ configId: cfg.id, version: cfg.version, status: cfg.status, sectionId: section.id, key: section.key, content: before });
        updates.push({ id: section.id, content: next, label, changes });
      }
    }
  }

  for (const u of updates) console.log(`${dryRun ? "[dry-run] " : ""}${u.label}: ${u.changes.join(", ")}`);
  if (updates.length === 0) console.log("Nothing to change — already applied or edited by an admin.");
  if (!dryRun && updates.length) {
    const file = `/var/log/mocktestseries/legal-content-backup-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(backup, null, 1), { mode: 0o600 });
    console.log(`Backup of previous content: ${file}`);
    await prisma.$transaction(updates.map((u) => prisma.homepageSection.update({ where: { id: u.id }, data: { content: u.content as Prisma.InputJsonValue } })));
    console.log(`Updated ${updates.length} section(s).`);
  }
  if (blocked) process.exitCode = 3;
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
