/**
 * Admin upgrade — library-level verification (read-only on the target DB).
 *
 *   DATABASE_URL=<scratch copy> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-admin-upgrade.ts
 *
 * Refuses to run against the production database name. Covers:
 *  - All Students: every non-deleted student reachable by paging, search
 *    (Student ID variants, name, email, mobile), account/access filters
 *    partition the total, deterministic ordering, no writes;
 *  - dashboard metrics vs independent SQL (Online Now, Active 7d, multiple
 *    sessions, communications, Action Required RBAC);
 *  - dashboard layout ordering rules;
 *  - monochrome palettes: CSS per mode and WCAG contrast in Day and Night;
 *  - backup verification compares the schema with the LIVE release.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const db = new URL((process.env.DATABASE_URL ?? "").split("?")[0]).pathname.slice(1);
  if (!db || db === "mocktestseries") throw new Error(`Refusing to run against database "${db}" — point DATABASE_URL at a scratch copy.`);
  const { prisma } = await import("../lib/prisma");
  const { loadStudentList, parseStudentListParams, normalizeStudentCode } = await import("../lib/admin-students-list");
  const { getLiveActivity, getMultipleSessions, getCommunicationsSummary, getActionRequired } = await import("../lib/admin-dashboard-metrics");
  const { applyDashboardOrder, sanitizeDashboardOrder, DASHBOARD_CARD_IDS } = await import("../lib/admin-dashboard-layout");
  const { APPEARANCE_PALETTES, BRAND_GREEN, contrastRatio } = await import("../lib/appearance-palettes");
  const { appearanceToCssVariables, appearanceDefaultMode, DEFAULT_APPEARANCE } = await import("../lib/appearance");
  const { latestMigrationOnDisk } = await import("../lib/backup/package");

  const fingerprint = async () =>
    prisma.$queryRawUnsafe<{ n: bigint; u: Date | null }[]>(`SELECT count(*) AS n, max("updatedAt") AS u FROM "Student"`).then((r) => `${r[0].n}:${r[0].u?.toISOString()}`);
  const before = await fingerprint();

  console.log("\n== All Students");
  const nonDeleted = await prisma.student.findMany({ where: { status: { not: "DELETED" } }, select: { id: true, studentId: true, name: true, email: true, mobile: true } });
  const base = parseStudentListParams({});
  check("Defaults: 50 per page, newest, page 1", base.perPage === 50 && base.sort === "newest" && base.page === 1);
  check("Invalid params fall back safely", JSON.stringify(parseStudentListParams({ per: "9999", page: "-3", account: "x", access: "y", sort: "z" })) === JSON.stringify(base));
  for (const per of [25, 200] as const) {
    const seen = new Set<string>();
    let page = 1;
    let pageCount = 1;
    do {
      const r = await loadStudentList({ ...base, perPage: per, page });
      r.rows.forEach((s) => seen.add(s.id));
      pageCount = r.pageCount;
      if (page === 1) check(`per=${per}: total = all non-deleted students (${nonDeleted.length})`, r.total === nonDeleted.length && r.filtered === nonDeleted.length, `${r.total}/${r.filtered}`);
      page++;
    } while (page <= pageCount);
    check(`per=${per}: paging through ${pageCount} page(s) reaches every student exactly once`, seen.size === nonDeleted.length && nonDeleted.every((s) => seen.has(s.id)), `${seen.size}/${nonDeleted.length}`);
  }
  const big = await loadStudentList({ ...base, perPage: 200, page: 1 });
  check("200 per page returns 200 rows when more exist (no hidden cap)", nonDeleted.length <= 200 || big.rows.length === 200);
  const pastEnd = await loadStudentList({ ...base, page: 9999 });
  check("Page beyond the end clamps to the last page", pastEnd.page === pastEnd.pageCount && pastEnd.rows.length > 0);

  const newest = (await loadStudentList({ ...base, perPage: 200 })).rows.map((r) => r.id);
  const oldestAll: string[] = [];
  for (let p = 1; ; p++) {
    const r = await loadStudentList({ ...base, perPage: 200, sort: "oldest", page: p });
    oldestAll.push(...r.rows.map((x) => x.id));
    if (p >= r.pageCount) break;
  }
  check("Oldest order is the exact reverse of newest (deterministic)", JSON.stringify(oldestAll.slice().reverse().slice(0, newest.length)) === JSON.stringify(newest));
  const again = (await loadStudentList({ ...base, perPage: 200 })).rows.map((r) => r.id);
  check("Same query twice → same order", JSON.stringify(again) === JSON.stringify(newest));

  check('normalizeStudentCode("MTS0030") = MTS-000030', normalizeStudentCode("MTS0030") === "MTS-000030" && normalizeStudentCode("mts-30") === "MTS-000030" && normalizeStudentCode("30") === "MTS-000030");
  const oldestStudent = await prisma.student.findFirst({ where: { status: { not: "DELETED" } }, orderBy: { createdAt: "asc" } });
  if (oldestStudent) {
    const compact = oldestStudent.studentId.replace("-", "");
    const r = await loadStudentList({ ...base, q: compact });
    check(`Oldest student ${oldestStudent.studentId} found by "${compact}"`, r.rows.some((x) => x.id === oldestStudent.id));
    const byName = await loadStudentList({ ...base, q: oldestStudent.name.toUpperCase().slice(0, 6) });
    check("Search by name (case-insensitive)", byName.rows.some((x) => x.id === oldestStudent.id) || byName.filtered > byName.rows.length);
  }
  const withEmail = nonDeleted.find((s) => s.email);
  if (withEmail) check("Search by email", (await loadStudentList({ ...base, q: withEmail.email! })).rows.some((x) => x.id === withEmail.id));
  const withMobile = nonDeleted.find((s) => s.mobile);
  if (withMobile) check("Search by mobile (last 6 digits)", (await loadStudentList({ ...base, q: withMobile.mobile!.slice(-6) })).rows.some((x) => x.id === withMobile.id));
  const sum = async (key: "account" | "access", vals: string[]) => {
    let n = 0;
    for (const v of vals) n += (await loadStudentList({ ...base, [key]: v } as typeof base)).filtered;
    return n;
  };
  check("Active + Inactive = all", (await sum("account", ["active", "inactive"])) === nonDeleted.length);
  check("Premium + Trial + Free = all (each student in exactly one)", (await sum("access", ["premium", "trial", "free"])) === nonDeleted.length);
  const prem = await loadStudentList({ ...base, access: "premium", perPage: 200 });
  check("Premium filter rows are labelled PREMIUM", prem.rows.every((r) => r.access === "PREMIUM"), `${prem.filtered} premium`);
  const trial = await loadStudentList({ ...base, access: "trial", perPage: 200 });
  check("Trial filter rows are labelled TRIAL", trial.rows.every((r) => r.access === "TRIAL"), `${trial.filtered} on trial`);
  check("Listing wrote nothing to Student", (await fingerprint()) === before);

  console.log("\n== Dashboard metrics vs independent SQL");
  const now = new Date();
  const live = await getLiveActivity(now);
  const q1 = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(DISTINCT x.s) AS n FROM (
       SELECT "studentId" s FROM "StudentSession" WHERE "revokedAt" IS NULL AND "expiresAt" > $1 AND "lastSeenAt" >= $2
       UNION SELECT "studentId" FROM "StudentDevice" WHERE active AND "lastSeenAt" >= $2) x
     JOIN "Student" st ON st.id = x.s AND st.status <> 'DELETED'`,
    now,
    new Date(now.getTime() - 10 * 60_000)
  );
  check("Online Now = distinct students touched in 10 min", live.onlineNow === Number(q1[0].n), `${live.onlineNow}`);
  const wk = new Date(now.getTime() - 7 * 86400_000);
  const q7 = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(DISTINCT x.s) AS n FROM (
       SELECT "studentId" s FROM "StudentSession" WHERE "revokedAt" IS NULL AND "lastSeenAt" >= $1
       UNION SELECT "studentId" FROM "StudentDevice" WHERE active AND "lastSeenAt" >= $1
       UNION SELECT id FROM "Student" WHERE "lastLoginAt" >= $1
       UNION SELECT "studentId" FROM "TestAttempt" WHERE "startedAt" >= $1) x
     JOIN "Student" st ON st.id = x.s AND st.status <> 'DELETED'`,
    wk
  );
  check("Active (7d) = sessions/devices/sign-ins/attempts in 7 days", live.active7d === Number(q7[0].n), `${live.active7d}`);
  check("Total students excludes DELETED", live.totalStudents === nonDeleted.length && live.deletedStudents === (await prisma.student.count({ where: { status: "DELETED" } })));
  check("Online ≤ 24h ≤ 7d", live.onlineNow <= live.active24h && live.active24h <= live.active7d);

  const multi = await getMultipleSessions(now);
  const qm = await prisma.$queryRawUnsafe<{ s: string; n: bigint }[]>(
    `SELECT ss."studentId" s, count(*) n FROM "StudentSession" ss JOIN "StudentDevice" d ON d.id = ss."deviceId" JOIN "Student" st ON st.id = ss."studentId"
     WHERE ss."revokedAt" IS NULL AND ss."expiresAt" > $1 AND ss."lastSeenAt" >= $2 AND d.active AND st.status <> 'DELETED' GROUP BY 1 HAVING count(*) >= 2`,
    now,
    new Date(now.getTime() - 24 * 3600_000)
  );
  check("Multiple sessions: 2+ count matches SQL", multi.twoPlus === qm.length, `${multi.twoPlus}`);
  check("Multiple sessions: 3+ and highest match SQL", multi.threePlus === qm.filter((r) => Number(r.n) >= 3).length && multi.highest === qm.reduce((m, r) => Math.max(m, Number(r.n)), 0));
  check("Multiple sessions rows never expose token hashes", !JSON.stringify(multi.rows).includes("tokenHash"));

  const comms = await getCommunicationsSummary();
  const pending = await prisma.communication.groupBy({ by: ["type"], where: { status: { in: ["NEW", "READ", "IN_PROGRESS"] } }, _count: { _all: true } });
  const pc = (t: string) => pending.find((p) => p.type === t)?._count._all ?? 0;
  check("Communications: Contact / Grow With Us pending match SQL", comms.contactPending === pc("CONTACT") && comms.growPending === pc("GROW_WITH_US"), `${comms.contactPending}/${comms.growPending}`);
  check("Communications: unread = NEW", comms.unread === (await prisma.communication.count({ where: { status: "NEW" } })));

  const none = await getActionRequired({ communications: false, reports: false, deletion: false, recovery: false, payments: false });
  check("Action Required: no permissions → no rows", none.length === 0);
  const onlyComms = await getActionRequired({ communications: true, reports: false, deletion: false, recovery: false, payments: false });
  check("Action Required: communications only → Contact + Grow With Us rows only", onlyComms.map((a) => a.key).join(",") === "contact,grow-with-us");
  const all = await getActionRequired({ communications: true, reports: true, deletion: true, recovery: true, payments: true });
  check("Action Required: no item counted twice (Contact + Grow = all pending communications)", all.find((a) => a.key === "contact")!.pending + all.find((a) => a.key === "grow-with-us")!.pending === pc("CONTACT") + pc("GROW_WITH_US"));
  check("Action Required: reports/recovery match SQL", all.find((a) => a.key === "reports")!.pending === (await prisma.reportedQuestion.count({ where: { status: "OPEN" } })) && all.find((a) => a.key === "recovery")!.pending === (await prisma.accountRecoveryRequest.count({ where: { status: "PENDING" } })));
  check("Action Required: priority none ⇔ zero pending", all.every((a) => (a.pending === 0) === (a.priority === "none")));

  console.log("\n== Dashboard layout");
  const items = DASHBOARD_CARD_IDS.map((id) => ({ id }));
  check("sanitize drops unknown/duplicate ids", JSON.stringify(sanitizeDashboardOrder(["online-now", "evil", "online-now", 3, "audit-log"])) === JSON.stringify(["online-now", "audit-log"]));
  check("No saved order → default order", applyDashboardOrder(items, []).map((i) => i.id).join() === DASHBOARD_CARD_IDS.join());
  const savedFull = ["audit-log", ...DASHBOARD_CARD_IDS.filter((id) => id !== "audit-log")];
  const custom = applyDashboardOrder(items, savedFull).map((i) => i.id);
  check("Saved order is applied exactly", custom.join() === savedFull.join());
  // A card added after the layout was saved appears right after its default predecessor.
  const withoutNew = savedFull.filter((id) => id !== "communications");
  const placed = applyDashboardOrder(items, withoutNew).map((i) => i.id);
  const prevDefault = DASHBOARD_CARD_IDS[DASHBOARD_CARD_IDS.indexOf("communications") - 1];
  check("New card appears once, right after its default predecessor", placed.length === items.length && new Set(placed).size === items.length && placed[placed.indexOf(prevDefault) + 1] === "communications");
  const restricted = applyDashboardOrder(items.filter((i) => i.id !== "revenue-mtd"), ["revenue-mtd", "online-now"]).map((i) => i.id);
  check("A saved layout cannot add a card the viewer may not see", !restricted.includes("revenue-mtd"));

  console.log("\n== Monochrome palettes");
  const DAY = { background: "#FBFBFC", card: "#FFFFFF", foreground: "#16171A" };
  const NIGHT = { background: "#000000", card: "#171717", foreground: "#F5F5F5" };
  const brand = APPEARANCE_PALETTES.find((p) => p.id === "brand-default")!;
  check("Brand default palette = current production brand green (#008209)", brand.name === "Brand Green (default)" && brand.colors.primary === "#008209" && JSON.stringify(brand.colors) === JSON.stringify(BRAND_GREEN));
  check("Brand default palette never uses stock blue #3B82F6", !Object.values(brand.colors).some((c) => c.toLowerCase() === "#3b82f6"));
  const brandCss = appearanceToCssVariables({ ...DEFAULT_APPEARANCE, colors: brand.colors, paletteId: brand.id });
  const noPaletteCss = appearanceToCssVariables({ ...DEFAULT_APPEARANCE, colors: brand.colors, paletteId: null });
  check("Brand Green palette renders the same CSS as the current saved colors (no palette)", brandCss === noPaletteCss);
  const defaultCss = appearanceToCssVariables(DEFAULT_APPEARANCE);
  check("Default appearance CSS unchanged (no extra mode rules)", !defaultCss.includes("data-theme") && !defaultCss.includes(".text-white"));
  for (const id of ["midnight-monochrome", "clean-monochrome"]) {
    const p = APPEARANCE_PALETTES.find((x) => x.id === id)!;
    const css = appearanceToCssVariables({ ...DEFAULT_APPEARANCE, colors: p.colors, paletteId: p.id });
    const own = p.themeType;
    const other = own === "dark" ? "light" : "dark";
    check(`${p.name}: own mode (${own}) gets its background/surface/text/border`, css.includes(`:root[data-theme="${own}"]{--color-background:${p.structural!.background}`));
    check(`${p.name}: other mode (${other}) gets the counterpart brand colors`, css.includes(`:root[data-theme="${other}"]{--color-primary:${p.counterpart!.primary}`));
    check(`${p.name}: default display mode = ${p.defaultMode}`, appearanceDefaultMode({ ...DEFAULT_APPEARANCE, colors: p.colors, paletteId: p.id }) === p.defaultMode);
    check(`${p.name}: eyesaver untouched`, !css.includes("eyesaver"));
    const ownBg = p.structural!;
    const otherBg = other === "light" ? DAY : NIGHT;
    const otherColors = p.counterpart!;
    const ratios = [
      ["text on background (own mode)", contrastRatio(ownBg.foreground, ownBg.background)],
      ["muted text on background (own mode)", contrastRatio(ownBg.mutedForeground, ownBg.background)],
      ["primary/link on background (own mode)", contrastRatio(p.colors.primary, ownBg.background)],
      ["primary/link on card (own mode)", contrastRatio(p.colors.primary, ownBg.card)],
      ["primary/link on background (other mode)", contrastRatio(otherColors.primary, otherBg.background)],
      ["primary/link on card (other mode)", contrastRatio(otherColors.primary, otherBg.card)],
    ] as const;
    for (const [label, r] of ratios) check(`${p.name}: ${label} ≥ 4.5:1`, r >= 4.5, r.toFixed(2));
    for (const t of ["success", "error", "warning", "info"] as const) {
      const r = contrastRatio(p.colors[t], ownBg.card);
      check(`${p.name}: ${t} status text on card ≥ 3:1`, r >= 3, r.toFixed(2));
    }
    const lightPrimary = p.colors.primary.toUpperCase() === "#FFFFFF";
    check(`${p.name}: white text on a white primary fill flips to black ink`, !lightPrimary || css.includes(`:root[data-theme="${own}"] .text-white:is(.bg-\\[var\\(--color-primary\\)\\]`));
  }
  const monoMismatch = { ...DEFAULT_APPEARANCE, colors: { ...APPEARANCE_PALETTES[1].colors, primary: "#123456" }, paletteId: null };
  check("A manually edited palette is custom (no mode rules)", !appearanceToCssVariables(monoMismatch).includes("data-theme=\"light\"]{"));

  console.log("\n== Backup schema check uses the live release");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mts-verify-schema-"));
  try {
    for (const [dir, names] of [
      ["repo", ["20260101000000_a"]],
      ["release", ["20260101000000_a", "20261014000000_b"]],
    ] as const)
      for (const n of names) {
        await mkdir(path.join(tmp, dir, "prisma", "migrations", n), { recursive: true });
        await writeFile(path.join(tmp, dir, "prisma", "migrations", n, "migration.sql"), "-- x\n");
      }
    check("latestMigrationOnDisk(release) is the newer schema", (await latestMigrationOnDisk(path.join(tmp, "release"))) === "20261014000000_b");
    check("…while the stale working copy reports an older one (the old false 'incompatible')", (await latestMigrationOnDisk(path.join(tmp, "repo"))) === "20260101000000_a");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
