/**
 * Verifies the homepage Platform Stats / Social Proof section:
 *
 *  1. Number formatting (lib/homepage-stat-format.ts) — Exact / K / K+ /
 *     Lakh / Lakh+, "+" formats never overstate, suffix de-duplication,
 *     manual-number parsing.
 *  2. Admin input sanitization (lib/homepage-stat-sanitize.ts) — markup
 *     stripped, enums allow-listed, unsafe links dropped, lengths capped.
 *  3. Live accuracy — the statistics aggregate (lib/homepage-statistics.ts)
 *     equals independent raw-SQL counts for the 4 default cards.
 *  4. Resolution (resolveStatisticsCards) — LIVE vs MANUAL, show/hide,
 *     order, formatting, hide-zero, legacy card shapes, aggregates only.
 *  5. Render — the public StatisticsSection HTML (rendered in a child
 *     process, scripts/verify-homepage-stats.render.tsx, since react-dom/
 *     server can't load under the react-server condition) server-renders
 *     the final numbers and carries no student identity.
 *
 * Read-only against the database. Run from the repo root:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-homepage-stats.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { formatStatNumber, parseManualNumber, withSuffix } from "@/lib/homepage-stat-format";
import { isValidCustomDisplayValue, sanitizeStatisticsContent, validateStatisticsMetrics } from "@/lib/homepage-stat-sanitize";
import { normalizeStatMetrics } from "@/lib/homepage-field-codec";
import { DEFAULT_STAT_METRICS } from "@/lib/homepage-sections";
import { computeHomepageStatistics } from "@/lib/homepage-statistics";
import { resolveStatisticsCards, type ResolvedStatValue } from "@/lib/homepage-render";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log("1. Formatting");
  check("EXACT uses Indian grouping", () => assert.equal(formatStatNumber(125430, "EXACT"), "1,25,430"));
  check("K rounds to one decimal", () => assert.equal(formatStatNumber(125430, "K"), "125.4K"));
  check("K drops trailing .0", () => assert.equal(formatStatNumber(2000, "K"), "2K"));
  check("K+ floors", () => assert.equal(formatStatNumber(125999, "K_PLUS"), "125K+"));
  check("LAKH rounds", () => assert.equal(formatStatNumber(125430, "LAKH"), "1.3 Lakh"));
  check("LAKH+ floors (never overstates)", () => assert.equal(formatStatNumber(119999, "LAKH_PLUS"), "1.1 Lakh+"));
  check("below unit falls back to exact", () => {
    assert.equal(formatStatNumber(74, "K"), "74");
    assert.equal(formatStatNumber(74, "K_PLUS"), "74+");
    assert.equal(formatStatNumber(2729, "LAKH"), "2,729");
  });
  check("zero never gets a +", () => assert.equal(formatStatNumber(0, "K_PLUS"), "0"));
  check("negative / NaN clamp to 0", () => {
    assert.equal(formatStatNumber(-5), "0");
    assert.equal(formatStatNumber(Number.NaN), "0");
  });
  check("suffix appended once", () => {
    assert.equal(withSuffix("125K+", "+"), "125K+");
    assert.equal(withSuffix("2,729", "+"), "2,729+");
    assert.equal(withSuffix("2,729", undefined), "2,729");
  });
  check("manual parsing", () => {
    assert.equal(parseManualNumber("12,500"), 12500);
    assert.equal(parseManualNumber(" 50000 "), 50000);
    assert.equal(parseManualNumber("50+"), null);
    assert.equal(parseManualNumber("4.8/5"), null);
    assert.equal(parseManualNumber(""), null);
  });

  console.log("2. Sanitization");
  const dirty = sanitizeStatisticsContent({
    heading: "<script>alert(1)</script>Hello",
    subheading: "x".repeat(500),
    background: "url(javascript:alert(1))",
    showModeBadge: "yes",
    metrics: [
      {
        id: "a",
        label: "<img src=x onerror=alert(1)>Students",
        icon: "notAnIcon",
        link: "javascript:alert(1)",
        enabled: true,
        mode: "EVIL",
        dynamicKey: "constructor",
        format: "HEX",
        suffix: "+<b>long-suffix",
        manualValue: "<b>9</b>",
      },
      { id: "b", label: "Ok", icon: "users", link: "/exams/ruhs", enabled: false, mode: "LIVE", dynamicKey: "testsCompleted", format: "K_PLUS", suffix: "+" },
    ],
  });
  const [m1, m2] = dirty.metrics as Record<string, unknown>[];
  check("heading/label lose angle brackets", () => {
    assert.ok(!String(dirty.heading).includes("<"));
    assert.ok(!String(m1.label).includes("<"));
    assert.ok(!String(m1.manualValue).includes("<"));
  });
  check("lengths capped", () => {
    assert.equal(String(dirty.subheading).length, 240);
    assert.ok(String(m1.suffix).length <= 6);
  });
  check("background allow-listed", () => assert.equal(dirty.background, "DEFAULT"));
  check("booleans coerced", () => assert.equal(dirty.showModeBadge, false));
  check("unknown icon / dynamicKey / format dropped, mode falls back", () => {
    assert.equal(m1.icon, undefined);
    assert.equal(m1.dynamicKey, undefined);
    assert.equal(m1.format, undefined);
    assert.equal(m1.mode, "MANUAL");
  });
  check("unsafe link dropped, internal link kept", () => {
    assert.equal(m1.link, undefined);
    assert.equal(m2.link, "/exams/ruhs");
  });
  check("valid card preserved", () => {
    assert.equal(m2.enabled, false);
    assert.equal(m2.dynamicKey, "testsCompleted");
    assert.equal(m2.format, "K_PLUS");
  });
  check("card count capped", () => {
    const many = sanitizeStatisticsContent({ metrics: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, label: "x", enabled: true, mode: "MANUAL" })) });
    assert.equal((many.metrics as unknown[]).length, 12);
  });
  check("defaults = exactly 4 LIVE cards", () => {
    assert.deepEqual(
      DEFAULT_STAT_METRICS.map((m) => [m.label, m.mode, m.dynamicKey]),
      [
        ["Questions Available", "LIVE", "questionsAvailable"],
        ["Students Joined", "LIVE", "registeredStudents"],
        ["Tests Attempted", "LIVE", "testsCompleted"],
        ["Questions Attempted", "LIVE", "questionsAnswered"],
      ]
    );
  });

  check("custom display values: examples accepted, junk rejected", () => {
    for (const v of ["100+", "1,500+", "2.8K+", "10K+", "25,000", "5000", "1.2 Lakh+"]) assert.ok(isValidCustomDisplayValue(v), v);
    for (const v of ["", "abc", "100+<b>", "javascript:1", "9".repeat(17), "+100"]) assert.ok(!isValidCustomDisplayValue(v), v);
  });
  check("save validation: CUSTOM needs a valid value, every card a label", () => {
    const cards = (patch: Record<string, unknown>) => normalizeStatMetrics([{ ...DEFAULT_STAT_METRICS[1], ...patch }]);
    assert.equal(validateStatisticsMetrics(cards({})), null);
    assert.equal(validateStatisticsMetrics(cards({ mode: "MANUAL", manualValue: "100+" })), null);
    assert.ok(validateStatisticsMetrics(cards({ mode: "MANUAL", manualValue: "" })));
    assert.ok(validateStatisticsMetrics(cards({ mode: "MANUAL", manualValue: "lots" })));
    assert.ok(validateStatisticsMetrics(cards({ label: "" })));
    // A stored custom value on a LIVE card is kept but never validated or shown.
    assert.equal(validateStatisticsMetrics(cards({ mode: "LIVE", manualValue: "junk" })), null);
  });
  check("label edit persists through sanitization; markup stripped", () => {
    const out = sanitizeStatisticsContent({ metrics: [{ ...DEFAULT_STAT_METRICS[0], label: "Practice <i>Questions</i>" }] });
    assert.equal((out.metrics as { label: string }[])[0].label, "Practice iQuestions/i");
  });

  console.log("3. Live accuracy (raw SQL vs app aggregate)");
  const [sql] = await prisma.$queryRaw<{ students: bigint; tests: bigint; questions: bigint; answered: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM "Student" WHERE "status" <> 'DELETED') AS students,
      (SELECT COUNT(*) FROM "TestAttempt" WHERE "status" = 'SUBMITTED') AS tests,
      (SELECT COUNT(*) FROM "Question" q JOIN "Exam" e ON e."id" = q."examId" WHERE q."status" = 'PUBLISHED' AND e."isActive") AS questions,
      (SELECT COUNT(*) FROM "Answer" WHERE "status" IN ('ANSWERED', 'ANSWERED_AND_MARKED')) AS answered`;
  const expected = { students: Number(sql.students), tests: Number(sql.tests), questions: Number(sql.questions), answered: Number(sql.answered) };
  const snapshot = await computeHomepageStatistics();
  console.log(`    SQL: questions=${expected.questions} students=${expected.students} tests=${expected.tests} answered=${expected.answered}`);
  check("Questions Available = PUBLISHED questions of active exams", () => assert.equal(snapshot.values.questionsAvailable, expected.questions));
  check("Students Joined = non-deleted students", () => assert.equal(snapshot.values.registeredStudents, expected.students));
  check("Tests Attempted = SUBMITTED attempts", () => assert.equal(snapshot.values.testsCompleted, expected.tests));
  check("Questions Attempted = answered answers", () => assert.equal(snapshot.values.questionsAnswered, expected.answered));

  console.log("4. Resolution");
  const base = { heading: "Growing every day", hideZeroLive: true, metrics: DEFAULT_STAT_METRICS.map((m) => ({ ...m })) };
  const live = resolveStatisticsCards(base, snapshot);
  const fmt = (n: number) => `${n.toLocaleString("en-IN")}+`;
  check("default: 4 LIVE cards, in order, with live values", () => {
    assert.deepEqual(
      live.map((v) => [v.label, v.value, v.mode]),
      [
        ["Questions Available", fmt(expected.questions), "LIVE"],
        ["Students Joined", fmt(expected.students), "LIVE"],
        ["Tests Attempted", fmt(expected.tests), "LIVE"],
        ["Questions Attempted", fmt(expected.answered), "LIVE"],
      ]
    );
  });
  check("only aggregates leave the resolver", () => {
    const allowed = new Set(["label", "value", "numeric", "format", "suffix", "description", "icon", "badge", "link", "mode"]);
    for (const v of live) for (const k of Object.keys(v)) assert.ok(allowed.has(k), k);
  });

  const manual = resolveStatisticsCards(
    { ...base, metrics: base.metrics.map((m, i) => (i === 1 ? { ...m, label: "Students Preparing", mode: "MANUAL", manualValue: "100+" } : m)) },
    snapshot
  );
  check("CUSTOM shows the exact value and label, only for that card", () => {
    assert.equal(manual[1].value, "100+");
    assert.equal(manual[1].label, "Students Preparing");
    assert.equal(manual[1].numeric, undefined);
    assert.equal(manual[0].value, fmt(expected.questions));
  });
  check("CUSTOM never changes the real statistics", () => {
    assert.equal(snapshot.values.registeredStudents, expected.students);
  });
  check("CUSTOM values are shown verbatim, never reformatted", () => {
    for (const v of ["100+", "1,500+", "2.8K+", "10K+", "25,000", "5000"]) {
      const [card] = resolveStatisticsCards({ ...base, metrics: [{ ...base.metrics[2], mode: "MANUAL", manualValue: v }] }, snapshot);
      assert.equal(card.value, v);
    }
  });
  check("CUSTOM card without a value is not rendered", () => {
    const empty = resolveStatisticsCards({ ...base, metrics: [{ ...base.metrics[2], mode: "MANUAL", manualValue: "" }] }, snapshot);
    assert.equal(empty.length, 0);
  });
  const verbatim = resolveStatisticsCards({ ...base, metrics: [{ ...base.metrics[0], mode: "MANUAL", manualValue: "4.8/5", suffix: "" }] }, snapshot);
  check("legacy non-numeric MANUAL text shown verbatim, not animated", () => {
    assert.equal(verbatim[0].value, "4.8/5");
    assert.equal(verbatim[0].numeric, undefined);
  });
  check("switching MANUAL back to LIVE restores the live value", () => {
    const back = resolveStatisticsCards({ ...base, metrics: [{ ...base.metrics[1], mode: "LIVE", manualValue: "999" }] }, snapshot);
    assert.equal(back[0].value, fmt(expected.students));
  });
  check("hidden card is not rendered", () => {
    const hidden = resolveStatisticsCards({ ...base, metrics: base.metrics.map((m, i) => (i === 0 ? { ...m, enabled: false } : m)) }, snapshot);
    assert.deepEqual(hidden.map((v) => v.label), ["Students Joined", "Tests Attempted", "Questions Attempted"]);
  });
  check("card order follows admin order", () => {
    const reordered = resolveStatisticsCards({ ...base, metrics: [base.metrics[2], base.metrics[0], base.metrics[1]] }, snapshot);
    assert.deepEqual(reordered.map((v) => v.label), ["Tests Attempted", "Questions Available", "Students Joined"]);
  });
  check("K / K+ formats on live values", () => {
    const k = resolveStatisticsCards({ ...base, metrics: [{ ...base.metrics[0], format: "K", suffix: "" }, { ...base.metrics[0], id: "x", format: "K_PLUS", suffix: "+" }] }, snapshot);
    assert.equal(k[0].value, formatStatNumber(expected.questions, "K"));
    assert.equal(k[1].value, formatStatNumber(expected.questions, "K_PLUS"));
  });
  check("hide-zero drops LIVE zero cards only", () => {
    const zero = { ...snapshot, values: { ...snapshot.values, testsCompleted: 0 } };
    assert.equal(resolveStatisticsCards(base, zero).length, 3);
    assert.equal(resolveStatisticsCards({ ...base, hideZeroLive: false }, zero).length, 4);
  });
  check("legacy 2-mode cards still resolve", () => {
    const legacy = resolveStatisticsCards({ metrics: [{ label: "Mock Tests", source: "ADMIN_CONFIGURED", manualValue: "50+" }, { label: "PYQ", source: "DYNAMIC", dynamicKey: "previousYearPapers" }] }, snapshot);
    assert.equal(legacy[0].value, "50+");
    assert.equal(legacy[1].value, snapshot.values.previousYearPapers.toLocaleString("en-IN"));
  });

  console.log("5. Render (public HTML)");
  const scenarios: Record<string, { content: Record<string, unknown>; statValues: ResolvedStatValue[] }> = {
    live: { content: base, statValues: live },
    manual: { content: { ...base, background: "SURFACE", subheading: "Sub" }, statValues: manual },
    empty: { content: base, statValues: [] },
  };
  const html = JSON.parse(
    execFileSync("npx", ["tsx", "scripts/verify-homepage-stats.render.tsx"], {
      input: JSON.stringify(scenarios),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    })
  ) as Record<string, string>;
  check("live HTML server-renders final numbers (SEO / no-JS)", () => {
    for (const n of [expected.students, expected.tests, expected.questions, expected.answered]) assert.ok(html.live.includes(fmt(n)), fmt(n));
    assert.ok(html.live.includes("Students Joined") && html.live.includes("Growing every day"));
  });
  check("4 cards: 2 × 2 on phones/tablets, one row on desktop", () => assert.ok(html.live.includes("grid-cols-2 lg:grid-cols-4")));
  check("SURFACE background + subheading render", () => {
    assert.ok(html.manual.includes("bg-[var(--color-surface)]"));
    assert.ok(html.manual.includes("Sub"));
    assert.ok(html.manual.includes("100+") && html.manual.includes("Students Preparing"));
  });
  check("no cards → section omitted", () => assert.equal(html.empty, ""));
  check("HTML carries no student identity", () => {
    for (const h of Object.values(html)) {
      assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(h), "email-like text");
      assert.ok(!/MTS-\d{3,}/.test(h), "student code");
    }
  });

  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
