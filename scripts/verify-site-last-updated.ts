/**
 * FOOTER "LAST UPDATED" DATE — library regression (lib/site-last-updated.ts).
 *
 * Covers IST formatting, manual-date validation, the automatic rule (later of
 * the successful-deployment marker and the newest public-content AuditLog
 * row), which AuditLog actions move the date (admin content changes) and
 * which don't (logins, student activity, AI, settings of the line itself),
 * and the Setting round trip with its defaults. The footer rendering and the
 * Admin form are checked over HTTP by scripts/verify-site-last-updated.mjs.
 *
 * Run from the repo root against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-site-last-updated.ts
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import {
  formatIstDate,
  getLastUpdatedConfig,
  getLatestPublicContentChange,
  isPublicContentAuditAction,
  istToday,
  parseManualDate,
  resolveLastUpdatedLabel,
  saveLastUpdatedConfig,
  type LastUpdatedConfig,
} from "@/lib/site-last-updated";

const dbName = new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname.slice(1);
if (!dbName || dbName === "mocktestseries") {
  console.error(`Refusing to run against database "${dbName}" — use a disposable scratch database.`);
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}`, detail ?? "");
  }
}

const AUTO: LastUpdatedConfig = { show: true, mode: "AUTOMATIC", manualDate: "", updatedAt: null };

async function main() {
  console.log("IST date conversion");
  check("18:29 UTC stays the same IST day", formatIstDate(new Date("2026-10-11T18:29:00Z")) === "11 October 2026");
  check("18:30 UTC is already the next IST day", formatIstDate(new Date("2026-10-11T18:30:00Z")) === "12 October 2026");
  check("single-digit day is zero-padded (DD Month YYYY)", formatIstDate(new Date("2026-03-04T06:00:00Z")) === "04 March 2026");
  check("year rollover in IST", formatIstDate(new Date("2026-12-31T19:00:00Z")) === "01 January 2027");
  check("istToday uses IST", istToday(new Date("2026-10-11T19:00:00Z")) === "2026-10-12");

  console.log("Manual date validation");
  check("valid date parses", parseManualDate("2026-02-28") !== null);
  check("leap day 2028 parses", parseManualDate("2028-02-29") !== null);
  for (const bad of ["2026-02-30", "2026-13-01", "26-10-11", "2026-10-1", "", "2026-10-11T00:00"]) {
    check(`rejects "${bad}"`, parseManualDate(bad) === null);
  }

  console.log("Resolution rules");
  const deployedAt = "2026-10-11T04:01:23.000Z";
  const older = "2026-10-08T10:00:00.000Z";
  const newer = "2026-10-12T20:00:00.000Z"; // 13 Oct in IST
  check("automatic: deployment newer than content", resolveLastUpdatedLabel(AUTO, { deployedAt, contentChangedAt: older }) === "11 October 2026");
  check("automatic: content newer than deployment", resolveLastUpdatedLabel(AUTO, { deployedAt, contentChangedAt: newer }) === "13 October 2026");
  check("automatic: no deployment marker → content date", resolveLastUpdatedLabel(AUTO, { deployedAt: null, contentChangedAt: older }) === "08 October 2026");
  check("automatic: nothing known → hidden", resolveLastUpdatedLabel(AUTO, { deployedAt: null, contentChangedAt: null }) === null);
  check("OFF hides the line", resolveLastUpdatedLabel({ ...AUTO, show: false }, { deployedAt, contentChangedAt: newer }) === null);
  check(
    "manual shows the picked date, ignoring newer changes",
    resolveLastUpdatedLabel({ ...AUTO, mode: "MANUAL", manualDate: "2026-09-05" }, { deployedAt, contentChangedAt: newer }) === "05 September 2026"
  );
  check(
    "manual without a valid date falls back to automatic",
    resolveLastUpdatedLabel({ ...AUTO, mode: "MANUAL", manualDate: "" }, { deployedAt, contentChangedAt: older }) === "11 October 2026"
  );
  check(
    "OFF wins over manual",
    resolveLastUpdatedLabel({ ...AUTO, show: false, mode: "MANUAL", manualDate: "2026-09-05" }, { deployedAt, contentChangedAt: null }) === null
  );

  console.log("Which admin changes move the date");
  const moves = [
    "HOMEPAGE_PUBLISHED", "HOMEPAGE_STATISTICS_REFRESHED", "QUESTION_CREATED", "QUESTION_UPDATED", "QUESTION_STATUS_CHANGED",
    "QUESTION_BULK_PUBLISH", "QUESTION_BULK_DELETE", "QUESTION_RICH_FIELDS_UPDATED", "BULK_IMPORT_COMPLETED", "BULK_IMPORT_VALID_ONLY",
    "BULK_IMPORT_ROLLBACK", "IMPORT_QUESTION_DELETED", "MOCK_TEST_CREATED", "MOCK_TEST_UPDATED", "MOCK_TEST_STATUS_CHANGED",
    "MOCK_TEST_QUESTIONS_UPDATED", "TEST_SERIES_UPDATED", "PYP_CREATED", "PYP_UPDATED", "PYP_QUESTIONS_LINKED", "PYQ_DATA_CORRECTION",
    "EXAM_UPDATED", "EXAM_PUBLIC_CONTENT_UPDATED", "SUBJECT_CREATED", "TOPIC_UPDATED", "SYLLABUS_EXAM_DESCRIPTION_UPDATED",
    "PRODUCT_CREATED", "PRODUCT_UPDATED", "PAYMENT_MODE_CHANGED", "GROUP_DISCOUNT_OFFER_TOGGLED", "TEST_SERIES_OFFER_DISPLAY_UPDATED",
    "SEO_SETTINGS_SAVED", "APPEARANCE_CHANGED", "TELEGRAM_CHANNEL_CONFIG_SAVED", "WHATSAPP_SUPPORT_CONFIG_SAVED",
    "ANNOUNCEMENT_PUBLISHED", "REVIEW_BULK_PUBLISH", "REVIEWS_SECTION_SETTINGS_SAVED", "CUSTOM_MODULE_STATUS_CHANGED",
  ];
  const stays = [
    "ADMIN_LOGIN", "ADMIN_LOGOUT", "STUDENT_LOGOUT_ALL", "STUDENT_DEVICE_REVOKED", "STUDENT_DELETION_REQUESTED",
    "QUESTION_REPORTED", "QUESTION_REPORT_STATUS_CHANGED", "AI_SETTINGS_SAVED", "AI_EXPLANATION_GENERATED", "API_ANTHROPIC_TESTED",
    "INSTAGRAM_PUBLISHED", "BACKUP_CREATED", "RELEASE_DELETED", "EMAIL_CAMPAIGN_QUEUED", "COUPON_CREATED", "ENTITLEMENT_GRANTED",
    "GATEWAY_TESTED", "COMMUNICATION_STATUS_CHANGED", "PLATFORM_CONTROL_CHANGED", "LAST_UPDATED_SETTINGS_SAVED",
    "HOMEPAGE_SECTION_UPDATED", "HOMEPAGE_SEO_UPDATED", "HOMEPAGE_VERSION_RESTORED", "BULK_IMPORT_UPLOADED", "BULK_IMPORT_ROW_EDITED",
  ];
  const wrongMoves = moves.filter((a) => !isPublicContentAuditAction(a));
  const wrongStays = stays.filter((a) => isPublicContentAuditAction(a));
  check(`${moves.length} public-content actions move the date`, wrongMoves.length === 0, wrongMoves);
  check(`${stays.length} non-content actions do not`, wrongStays.length === 0, wrongStays);

  // Every literal action name in the code base is classified one way or the
  // other; print the "moves" list so a reviewer can eyeball it.
  const literals = execFileSync("git", ["grep", "-hoE", 'action: "[A-Z][A-Z0-9_]+"', "--", "app", "lib"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.replace(/^action: "|"$/g, ""))
    .filter(Boolean);
  const unique = [...new Set(literals)].sort();
  console.log(`  info  ${unique.length} literal audit actions; moving the date: ${unique.filter(isPublicContentAuditAction).join(", ")}`);

  console.log("Database: newest public-content change (filter matches the pure rule)");
  const tag = `lu-verify-${Date.now()}`;
  const base = Date.now() - 60_000;
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: "lu-verify-" } } });
  const before = await getLatestPublicContentChange();
  const contentAt = new Date(base);
  await prisma.auditLog.create({ data: { action: "QUESTION_UPDATED", entityType: "Question", entityId: tag, createdAt: contentAt } });
  check("an admin question edit is the newest content change", (await getLatestPublicContentChange()) === contentAt.toISOString());
  // Later non-content rows: logins, student activity, AI, the line's own settings.
  let t = base;
  for (const action of ["ADMIN_LOGIN", "STUDENT_LOGOUT_ALL", "QUESTION_REPORT_STATUS_CHANGED", "AI_SETTINGS_SAVED", "LAST_UPDATED_SETTINGS_SAVED", "HOMEPAGE_SECTION_UPDATED"]) {
    t += 1000;
    await prisma.auditLog.create({ data: { action, entityType: "Test", entityId: tag, createdAt: new Date(t) } });
  }
  check("later logins / student / AI / settings rows don't move it", (await getLatestPublicContentChange()) === contentAt.toISOString());
  const publishAt = new Date(t + 1000);
  await prisma.auditLog.create({ data: { action: "HOMEPAGE_PUBLISHED", entityType: "HomepageConfig", entityId: tag, createdAt: publishAt } });
  check("a homepage publish moves it", (await getLatestPublicContentChange()) === publishAt.toISOString());
  await prisma.auditLog.deleteMany({ where: { entityId: tag } });
  check("cleanup restores the previous value", (await getLatestPublicContentChange()) === before);

  console.log("Setting round trip");
  const existing = await prisma.setting.findUnique({ where: { key: "website.last_updated" } });
  await prisma.setting.deleteMany({ where: { key: "website.last_updated" } });
  const defaults = await getLastUpdatedConfig();
  check("defaults: Show ON, Automatic", defaults.show === true && defaults.mode === "AUTOMATIC" && defaults.manualDate === "");
  await saveLastUpdatedConfig({ show: false, mode: "MANUAL", manualDate: "2026-09-05" });
  const saved = await getLastUpdatedConfig();
  check("saved values read back", saved.show === false && saved.mode === "MANUAL" && saved.manualDate === "2026-09-05" && Boolean(saved.updatedAt));
  await prisma.setting.update({ where: { key: "website.last_updated" }, data: { value: { show: true, mode: "WEIRD", manualDate: "2026-02-31" } } });
  const tolerant = await getLastUpdatedConfig();
  check("unknown mode / invalid date are normalized", tolerant.mode === "AUTOMATIC" && tolerant.manualDate === "");
  await prisma.setting.deleteMany({ where: { key: "website.last_updated" } });
  if (existing) await prisma.setting.create({ data: { key: existing.key, value: existing.value as object } });

  const otherFooterKeys = await prisma.setting.count({ where: { key: { in: ["website.whatsapp_support", "website.telegram_channel"] } } });
  console.log(`  info  other footer settings rows present: ${otherFooterKeys} (never touched by this suite)`);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
