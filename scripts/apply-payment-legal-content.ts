/**
 * One-time, idempotent payment-launch update of the admin-managed legal
 * content (Admin → Website → Homepage → Contact / About / Legal + Footer), on
 * both the PUBLISHED and the DRAFT homepage configs — same pattern as
 * scripts/backfill-communications-content.ts.
 *
 *  - Terms: replaces the pre-payments "No Payment Obligation Today" paragraph
 *    with the payments / digital access / refunds sections.
 *  - Privacy: replaces the pre-payments "Payments" paragraph with the
 *    Razorpay payment-processor disclosure.
 *  - Refund & Cancellation Policy: seeds the default draft only when empty.
 *  - Footer: adds a "Refund & Cancellation Policy" link when missing.
 *
 * Replacements happen only on an EXACT match of the original paragraph, so
 * text an admin has already edited is never overwritten. Everything else in
 * each section is left byte-for-byte. The previous content of every touched
 * section is written to a JSON backup first. Copy: lib/legal-payment-copy.ts.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/apply-payment-legal-content.ts [--dry-run]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";

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

  for (const cfg of configs) {
    for (const section of cfg.sections) {
      const before = (section.content ?? {}) as Record<string, unknown>;
      const next = { ...before };
      const changes: string[] = [];
      if (section.key === "CONTACT_INFO") {
        const terms = typeof before.termsBody === "string" ? before.termsBody : "";
        if (terms.includes(copy.LEGACY_TERMS_PAYMENT_BLOCK)) {
          next.termsBody = terms.replace(copy.LEGACY_TERMS_PAYMENT_BLOCK, copy.TERMS_PAYMENT_SECTION);
          next.termsLastUpdated = today;
          changes.push("terms payment section");
        }
        const privacy = typeof before.privacyBody === "string" ? before.privacyBody : "";
        if (privacy.includes(copy.LEGACY_PRIVACY_PAYMENT_BLOCK)) {
          next.privacyBody = privacy.replace(copy.LEGACY_PRIVACY_PAYMENT_BLOCK, copy.PRIVACY_PAYMENT_SECTION);
          next.privacyLastUpdated = today;
          changes.push("privacy payment disclosure");
        }
        if (!(typeof before.refundBody === "string" && before.refundBody.trim())) {
          next.refundBody = copy.REFUND_POLICY_DEFAULT;
          next.refundLastUpdated = today;
          changes.push("refund policy default");
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
        updates.push({ id: section.id, content: next, label: `${cfg.status} v${cfg.version} ${section.key}`, changes });
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
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
