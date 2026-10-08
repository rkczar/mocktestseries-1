/**
 * Homepage 5-card statistics, overrides and Telegram URL rules.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-homepage-admin-stats.ts
 *
 * Uses the real test engine (start / save / submit) and the real AI usage
 * logger on a scratch DB; cleans up everything it creates.
 */
import "dotenv/config";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeHomepageStatistics } from "@/lib/homepage-statistics";
import { saveAnswer, startMockTestAttempt, submitAttempt } from "@/lib/test-attempt";
import { logAiAccess } from "@/lib/student-data";
import { resolveStatisticsCards } from "@/lib/homepage-render";
import { normalizeStatMetrics, type StatMetric } from "@/lib/homepage-field-codec";
import { sanitizeStatisticsContent, validateStatisticsMetrics } from "@/lib/homepage-stat-sanitize";
import { DEFAULT_STAT_METRICS } from "@/lib/homepage-sections";
import { safeTelegramUrl } from "@/lib/telegram-url";
import { toFiveCards } from "./homepage-stats-five-cards";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const stats = async () => (await computeHomepageStatistics()).values;

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.findFirstOrThrow({ where: { isActive: true, questions: { some: { status: "PUBLISHED" } } } });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: "PUBLISHED", questionType: "SINGLE_CORRECT", options: { some: { isCorrect: true } } },
    take: 10,
    orderBy: { code: "asc" },
    include: { options: true },
  });
  if (bank.length < 10) throw new Error("need 10 published questions");
  const label = (qid: string, correct = true) => bank.find((q) => q.id === qid)!.options.find((o) => o.isCorrect === correct)!.label;
  const student = await prisma.student.create({
    data: { studentId: `HPS-${suffix}`, name: "HPS Student", email: `hps-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const mock = await prisma.mockTest.create({
    data: { examId: exam.id, title: `HPS ${suffix}`, durationMinutes: 60, status: "PUBLISHED", accessType: "FREE", questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) } },
  });

  try {
    console.log("\n--- Total Students ---");
    const s0 = await stats();
    const deleted = await prisma.student.create({ data: { studentId: `HPS-D-${suffix}`, name: "x", email: `hps-d-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS, status: "DELETED" } });
    check("deleted (tombstoned) accounts are not counted; the new student is", (await stats()).registeredStudents === s0.registeredStudents);
    await prisma.student.delete({ where: { id: deleted.id } });

    console.log("\n--- Questions Attempted / Tests Attempted (real engine) ---");
    const base = await stats();
    const a1 = await startMockTestAttempt(student.id, mock.id);
    let seq = 1;
    for (const q of bank) await saveAnswer(a1.id, student.id, q.id, label(q.id), false, seq++);
    const afterA1 = await stats();
    check("starting an attempt = Tests Attempted +1 (counted on start, not submit)", afterA1.testsStarted === base.testsStarted + 1, { base: base.testsStarted, now: afterA1.testsStarted });
    check("10 answered questions = +10", afterA1.questionsAnswered === base.questionsAnswered + 10, { d: afterA1.questionsAnswered - base.questionsAnswered });
    // Autosave repeats, answer changes, mark-for-review, resume.
    for (const q of bank.slice(0, 5)) await saveAnswer(a1.id, student.id, q.id, label(q.id), false, seq++);
    for (const q of bank.slice(0, 3)) await saveAnswer(a1.id, student.id, q.id, label(q.id, false), true, seq++);
    const resumed = await startMockTestAttempt(student.id, mock.id);
    check("resume/refresh returns the same attempt (no new attempt)", resumed.id === a1.id);
    const afterDup = await stats();
    check("autosave repeats, answer changes, mark-for-review, resume = +0", afterDup.questionsAnswered === afterA1.questionsAnswered && afterDup.testsStarted === afterA1.testsStarted, { d: afterDup.questionsAnswered - afterA1.questionsAnswered });
    await submitAttempt(a1.id, student.id);
    await submitAttempt(a1.id, student.id).catch(() => null);
    const afterSubmit = await stats();
    check("submit and repeated submit = +0", afterSubmit.questionsAnswered === afterA1.questionsAnswered && afterSubmit.testsStarted === afterA1.testsStarted);

    const a2 = await startMockTestAttempt(student.id, mock.id);
    check("second attempt is a new attempt", a2.id !== a1.id);
    for (const q of bank) await saveAnswer(a2.id, student.id, q.id, label(q.id), false, seq++);
    await submitAttempt(a2.id, student.id);
    const afterA2 = await stats();
    check("same 10 questions in 2 attempts = +20 total", afterA2.questionsAnswered === base.questionsAnswered + 20, { d: afterA2.questionsAnswered - base.questionsAnswered });
    check("2 attempts = Tests Attempted +2", afterA2.testsStarted === base.testsStarted + 2);

    const a3 = await startMockTestAttempt(student.id, mock.id);
    await saveAnswer(a3.id, student.id, bank[0].id, null, true, seq++); // marked only, no option
    await saveAnswer(a3.id, student.id, bank[1].id, label(bank[1].id), false, seq++);
    await saveAnswer(a3.id, student.id, bank[1].id, null, false, seq++); // cleared again
    await submitAttempt(a3.id, student.id);
    const afterA3 = await stats();
    check("viewed / marked-only / cleared / unanswered = +0", afterA3.questionsAnswered === afterA2.questionsAnswered, { d: afterA3.questionsAnswered - afterA2.questionsAnswered });

    console.log("\n--- AI Explanations Used ---");
    const ai0 = (await stats()).aiExplanationUses;
    const q = bank[0].id;
    await logAiAccess(student.id, q, { cacheHit: false, provider: "x", model: "y", feature: "EXPLANATION" });
    check("successful use = +1", (await stats()).aiExplanationUses === ai0 + 1);
    await logAiAccess(student.id, q, { cacheHit: true, provider: "x", model: "y", feature: "EXPLANATION" });
    check("duplicate retry within 60 s = +0", (await stats()).aiExplanationUses === ai0 + 1);
    await logAiAccess(student.id, q, { cacheHit: true, provider: "x", model: "y", feature: "EXPLANATION_VARIANT:simpler" });
    await logAiAccess(student.id, q, { cacheHit: true, provider: "x", model: "y", feature: "QUESTION_VARIANTS" });
    check("different AI features on the same question = separate uses (+2)", (await stats()).aiExplanationUses === ai0 + 3);
    await prisma.studentActivity.create({
      data: { studentId: student.id, activity: "AI_EXPLANATION_VIEWED", metadata: { questionId: q, cacheHit: true, feature: "EXPLANATION" }, createdAt: new Date(Date.now() + 5 * 60_000) },
    });
    check("explicit cached repeat later (>60 s) = +1", (await stats()).aiExplanationUses === ai0 + 4);
    await prisma.studentActivity.create({ data: { studentId: student.id, activity: "AI_EXPLANATION_GENERATED", metadata: { questionId: bank[2].id } } });
    await prisma.aIExplanation.updateMany({ where: { questionId: bank[3].id }, data: {} });
    check("generation records / stored explanations alone = +0", (await stats()).aiExplanationUses === ai0 + 4);

    console.log("\n--- Live / Custom overrides ---");
    const live = await computeHomepageStatistics();
    const metrics = (DEFAULT_STAT_METRICS as unknown as StatMetric[]).map((m) => ({ ...m }));
    const show = (ms: StatMetric[]) => resolveStatisticsCards({ metrics: ms }, live).map((c) => `${c.label}=${c.value}`);
    check("exactly 5 default cards in owner order", show(metrics).length === 5 && show(metrics).map((s) => s.split("=")[0]).join("|") === "Total Students|Tests Attempted|Questions Attempted|Questions Available|AI Explanations Used", show(metrics));
    for (const m of metrics) {
      const custom = metrics.map((x) => (x.id === m.id ? { ...x, mode: "MANUAL" as const, manualValue: "0" } : x));
      const sanitized = normalizeStatMetrics(sanitizeStatisticsContent({ metrics: custom }).metrics);
      const ok = !validateStatisticsMetrics(sanitized) && show(sanitized).includes(`${m.label}=0`);
      check(`${m.label}: CUSTOM 0 accepted and displayed as 0`, ok, show(sanitized));
      const reset = sanitized.map((x) => (x.id === m.id ? { ...x, mode: "LIVE" as const } : x));
      check(`${m.label}: reset to LIVE shows the live count again (custom value kept, unused)`, show(reset).includes(`${m.label}=${(live.values[m.dynamicKey!] ?? 0).toLocaleString("en-IN")}+`) && reset.find((x) => x.id === m.id)!.manualValue === "0");
    }
    const before = await prisma.answer.count();
    check("custom values never touch records", (await prisma.answer.count()) === before);
    const migrated = toFiveCards(
      normalizeStatMetrics([
        { id: "questions-available", label: "Questions Available", mode: "LIVE", dynamicKey: "questionBank", manualValue: "3256" },
        { id: "students-joined", label: "Students Joined", mode: "MANUAL", dynamicKey: "registeredStudents", manualValue: "356" },
        { id: "tests-attempted", label: "Tests Attempted", mode: "MANUAL", dynamicKey: "testsCompleted", manualValue: "406" },
        { id: "questions-attempted", label: "Questions Attempted", mode: "LIVE", dynamicKey: "questionsAnswered" },
      ])
    );
    check(
      "content migration keeps owner overrides (356 / 406 CUSTOM) and fixes data sources",
      migrated.map((m) => `${m.id}:${m.mode}:${m.manualValue ?? ""}:${m.dynamicKey}`).join(",") ===
        "students-joined:MANUAL:356:registeredStudents,tests-attempted:MANUAL:406:testsStarted,questions-attempted:LIVE::questionsAnswered,questions-available:LIVE:3256:questionsAvailable,ai-explanations-used:LIVE::aiExplanationUses",
      migrated
    );

    console.log("\n--- Telegram URL validation ---");
    for (const ok of ["https://t.me/mocktestseries", "https://telegram.me/mocktestseries", "https://t.me/+AbC123xyz", " https://t.me/s/channel_1 "]) check(`accepts ${ok.trim()}`, safeTelegramUrl(ok) !== null);
    for (const bad of ["javascript:alert(1)", "http://t.me/x", "https://t.me.evil.com/x", "https://evil.com/t.me/x", "data:text/html,x", "tg://resolve?domain=x", "https://user:pw@t.me/x", "https://t.me:8443/x", "https://t.me/", "", "//t.me/x"]) check(`rejects ${JSON.stringify(bad)}`, safeTelegramUrl(bad) === null);
  } finally {
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.studentActivity.deleteMany({ where: { studentId: student.id } });
    await prisma.mockTest.delete({ where: { id: mock.id } });
    await prisma.student.delete({ where: { id: student.id } });
  }
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
