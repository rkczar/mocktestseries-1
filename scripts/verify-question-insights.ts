/**
 * Verification for Admin → Analytics → Question Insights.
 *
 *   set -a; . ./.env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-question-insights.ts
 *
 * Part A (pure) and Part B (read-only aggregate cross-checks against
 * independent raw SQL) are safe on any database, including production —
 * Part B only ever SELECTs. Part C writes fixtures and therefore only runs
 * when the database name contains "qiverify" (a disposable scratch copy).
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import {
  PAGE_SIZE,
  getInsightOverview,
  getInsightRows,
  getTopQuestionIds,
  parseInsightFilters,
  prepareQuestionCopy,
  publicImageLink,
  resolveRange,
  type InsightFilters,
} from "@/lib/question-insights";
import { buildCopyBlocks, type CopyQuestion } from "@/lib/question-insights-format";

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

function q(i: number, over: Partial<CopyQuestion> = {}): CopyQuestion {
  return {
    id: `q${i}xxxxxxxxxx`,
    code: `T ${i}`,
    text: `Question text ${i} — keep < & exactly`,
    imageUrl: null,
    options: ["A", "B", "C", "D"].map((label) => ({ label, text: `Option ${label}${i}`, imageUrl: null, isCorrect: label === "C" })),
    wrongPct: 68.4,
    explanation: `Because ${i}`,
    ...over,
  };
}

async function partA() {
  console.log("Part A — formatter and date ranges (pure)");

  await check("single block contains every required field, exact text, no markdown", () => {
    const { blocks, excluded } = buildCopyBlocks({ questions: [q(1), q(2)], headline: "🔥 MOST MISSED QUESTIONS TODAY", subtitle: "RUHS MO 2026 | MockTestSeries.in", blockSize: 0, includeExplanation: false });
    assert.equal(blocks.length, 1);
    assert.equal(excluded.length, 0);
    const t = blocks[0].text;
    assert.ok(t.startsWith("🔥 MOST MISSED QUESTIONS TODAY\nRUHS MO 2026 | MockTestSeries.in\n\nQ1. Question text 1 — keep < & exactly\n\nA. OptionA1\n".replace("OptionA1", "Option A1")));
    assert.ok(t.includes("✅ Correct Answer: C. Option C1"));
    assert.ok(t.includes("📊 68% students answered incorrectly."));
    assert.ok(t.includes("Q2. Question text 2"));
    assert.ok(t.includes("━━━━━━━━━━━━━━━━━━"));
    assert.ok(t.trimEnd().endsWith("📚 Practice more:\nMockTestSeries.in"));
    assert.ok(!t.includes("💡"), "explanation off by default");
    assert.ok(!/\*[^*\n]+\*/.test(t) && !/(^|\s)_[^_\n]+_(\s|$)/.test(t), "no Telegram/WhatsApp markdown");
  });

  await check("20 questions in 10-per-block → 2 blocks, Q1–Q10 / Q11–Q20, continuous numbering", () => {
    const qs = Array.from({ length: 20 }, (_, i) => q(i + 1));
    const { blocks } = buildCopyBlocks({ questions: qs, headline: "H", subtitle: "S", blockSize: 10, includeExplanation: false });
    assert.deepEqual(blocks.map((b) => [b.from, b.to]), [[1, 10], [11, 20]]);
    assert.ok(blocks[1].text.includes("Q11. Question text 11") && !blocks[1].text.includes("Q10."));
    assert.ok(blocks[0].text.startsWith("H (Part 1/2)\nS") && blocks[1].text.startsWith("H (Part 2/2)"));
    assert.ok(blocks.every((b) => b.text.includes("📚 Practice more:")));
  });

  await check("12 questions in 5-per-block → 5/5/2", () => {
    const qs = Array.from({ length: 12 }, (_, i) => q(i + 1));
    const { blocks } = buildCopyBlocks({ questions: qs, headline: "H", subtitle: "S", blockSize: 5, includeExplanation: false });
    assert.deepEqual(blocks.map((b) => [b.from, b.to]), [[1, 5], [6, 10], [11, 12]]);
  });

  await check("broken answer keys are excluded, never guessed; numbering skips nothing", () => {
    const none = q(2, { options: q(2).options.map((o) => ({ ...o, isCorrect: false })) });
    const multi = q(3, { options: q(3).options.map((o) => ({ ...o, isCorrect: o.label !== "D" })) });
    const { blocks, excluded, includedCount } = buildCopyBlocks({ questions: [q(1), none, multi, q(4)], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: false });
    assert.deepEqual(excluded.map((e) => e.issue), ["NO_CORRECT_OPTION", "MULTIPLE_CORRECT_OPTIONS"]);
    assert.equal(includedCount, 2);
    assert.ok(blocks[0].text.includes("Q2. Question text 4"));
    assert.ok(!blocks[0].text.includes("Question text 2") && !blocks[0].text.includes("Question text 3"));
  });

  await check("explanation toggle uses the stored explanation only; image note; missing wrong % line omitted", () => {
    const img = q(1, { imageUrl: "/storage/question-images/x.png", wrongPct: null });
    const noExpl = q(2, { explanation: null });
    const { blocks } = buildCopyBlocks({ questions: [img, noExpl], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: true });
    const t = blocks[0].text;
    assert.ok(t.includes("💡 Explanation: Because 1"));
    assert.equal((t.match(/💡/g) ?? []).length, 1);
    assert.ok(t.includes("🖼 This question has an image — view it on MockTestSeries.in"));
    assert.equal((t.match(/📊/g) ?? []).length, 1);
  });

  await check("HTML question text becomes plain text; plain text is untouched", () => {
    const html = q(1, { text: "H<sub>2</sub>O is <b>water</b>" });
    const { blocks } = buildCopyBlocks({ questions: [html], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: false });
    assert.ok(blocks[0].text.includes("Q1. H₂O is water"));
  });

  await check("IST day boundaries (not UTC)", () => {
    // 2026-10-02 20:00 UTC = 2026-10-03 01:30 IST → "today" is 3 Oct IST.
    const now = new Date("2026-10-02T20:00:00Z");
    const today = resolveRange({ range: "today" }, now);
    assert.equal(today.from.toISOString(), "2026-10-02T18:30:00.000Z");
    assert.equal(today.to.toISOString(), "2026-10-03T18:30:00.000Z");
    const yesterday = resolveRange({ range: "yesterday" }, now);
    assert.equal(yesterday.from.toISOString(), "2026-10-01T18:30:00.000Z");
    assert.equal(yesterday.to.toISOString(), "2026-10-02T18:30:00.000Z");
    const last7 = resolveRange({ range: "7d" }, now);
    assert.equal(last7.from.toISOString(), "2026-09-26T18:30:00.000Z");
    const last30 = resolveRange({ range: "30d" }, now);
    assert.equal((last30.to.getTime() - last30.from.getTime()) / 86400000, 30);
    const custom = resolveRange({ range: "custom", from: "2026-09-01", to: "2026-09-03" }, now);
    assert.equal(custom.from.toISOString(), "2026-08-31T18:30:00.000Z");
    assert.equal(custom.to.toISOString(), "2026-09-03T18:30:00.000Z");
    assert.ok(resolveRange({ range: "custom", from: "2026-09-05", to: "2026-09-01" }, now).error);
    assert.ok(resolveRange({ range: "custom", from: "2020-01-01", to: "2026-09-01" }, now).error);
  });

  await check("filter validation rejects injection / unknown values", () => {
    const f = parseInsightFilters({ tab: "x", range: "1;drop", examId: "'; DROP TABLE x;--", testType: "NOPE", min: "3", sort: "id; --", page: "-4" });
    assert.equal(f.tab, "wrong");
    assert.equal(f.range, "today");
    assert.equal(f.examId, undefined);
    assert.equal(f.testType, undefined);
    assert.equal(f.min, 5);
    assert.equal(f.sort, "wrong");
    assert.equal(f.page, 1);
    assert.equal(parseInsightFilters({}).min, 5);
    assert.equal(parseInsightFilters({ tab: "attempted" }).sort, "attempts");
  });

  await check("only app-public question images get a share link", () => {
    assert.equal(publicImageLink("/storage/question-images/a.png"), "https://mocktestseries.in/storage/question-images/a.png");
    assert.equal(publicImageLink("https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=1"), null);
    assert.equal(publicImageLink("/storage/test-resources/a.pdf"), null);
    assert.equal(publicImageLink("/storage/question-images/../secret"), null);
  });
}

// Independent raw SQL — written separately from lib/question-insights.ts on purpose.
async function rawStats(from: Date, to: Date, minAttempts: number) {
  return prisma.$queryRawUnsafe<{ qid: string; attempts: number; correct: number; wrong: number }[]>(
    `SELECT a."questionId" qid, count(*)::int attempts, sum(case when a."isCorrect" then 1 else 0 end)::int correct, sum(case when a."isCorrect" = false then 1 else 0 end)::int wrong
     FROM "Answer" a, "TestAttempt" t, "Question" q
     WHERE t.id = a."attemptId" AND q.id = a."questionId" AND t.status = 'SUBMITTED' AND a."isCorrect" IS NOT NULL AND t."submittedAt" >= $1 AND t."submittedAt" < $2
     GROUP BY 1 HAVING count(*) >= $3`,
    from,
    to,
    minAttempts
  );
}

async function partB() {
  console.log("Part B — aggregates vs independent raw SQL (read-only)");
  const base = (over: Record<string, string> = {}): InsightFilters => parseInsightFilters({ range: "30d", min: "1", ...over });

  const f = base();
  const r = resolveRange(f);
  const raw = await rawStats(r.from, r.to, 1);
  const rawById = new Map(raw.map((x) => [x.qid, x]));

  await check(`overview matches raw (30d: ${raw.reduce((s, x) => s + x.attempts, 0)} answers, ${raw.length} questions)`, async () => {
    const o = await getInsightOverview(f, r);
    assert.equal(o.answered, raw.reduce((s, x) => s + x.attempts, 0));
    assert.equal(o.uniqueQuestions, raw.length);
    assert.equal(o.correct, raw.reduce((s, x) => s + x.correct, 0));
    assert.equal(o.wrong, raw.reduce((s, x) => s + x.wrong, 0));
    assert.equal(o.correct + o.wrong, o.answered);
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM "ReportedQuestion" WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      r.from,
      r.to
    );
    assert.equal(o.reports, n);
    const [{ all }] = await prisma.$queryRawUnsafe<{ all: number }[]>(
      `SELECT count(*)::int "all" FROM "Answer" a JOIN "TestAttempt" t ON t.id = a."attemptId"
       WHERE t.status = 'SUBMITTED' AND a."isCorrect" IS NOT NULL AND t."submittedAt" >= $1 AND t."submittedAt" < $2`,
      r.from,
      r.to
    );
    assert.equal(o.answered + o.deletedQuestionAnswers, all, "every scored answer is either counted or reported as deleted-question");
  });

  await check("unanswered / in-progress answers are never counted", async () => {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM "Answer" a JOIN "TestAttempt" t ON t.id = a."attemptId" JOIN "Question" q ON q.id = a."questionId"
       WHERE t.status = 'SUBMITTED' AND t."submittedAt" >= $1 AND t."submittedAt" < $2 AND a."selectedOptionLabel" IS NOT NULL`,
      r.from,
      r.to
    );
    const o = await getInsightOverview(f, r);
    assert.equal(o.answered, n, "answered == answers with a selected option on submitted attempts");
  });

  await check("Most Wrong page 1: counts per row match raw and ranking is by wrong count desc", async () => {
    const { rows, total } = await getInsightRows(f, r);
    assert.equal(total, raw.length);
    assert.equal(rows.length, Math.min(PAGE_SIZE, raw.length));
    for (const row of rows) {
      const x = rawById.get(row.id)!;
      assert.ok(x, `row ${row.code} in raw`);
      assert.deepEqual([row.attempts, row.correct, row.wrong], [x.attempts, x.correct, x.wrong], row.code);
      assert.ok(Math.abs((row.wrongPct ?? -1) - (x.wrong / x.attempts) * 100) < 1e-9);
    }
    const sortedWrong = [...raw].sort((a, b) => b.wrong - a.wrong || b.attempts - a.attempts).slice(0, rows.length).map((x) => x.wrong);
    assert.deepEqual(rows.map((x) => x.wrong), sortedWrong);
  });

  await check("minimum attempts filter (5+, 10+) matches raw HAVING", async () => {
    for (const min of [5, 10, 20]) {
      const fm = base({ min: String(min) });
      const { total, rows } = await getInsightRows(fm, r);
      assert.equal(total, (await rawStats(r.from, r.to, min)).length, `min ${min}`);
      assert.ok(rows.every((x) => x.attempts >= min));
    }
  });

  await check("Highest Wrong % / Most Attempted sorts", async () => {
    const byPct = (await getInsightRows(base({ sort: "wrongPct" }), r)).rows.map((x) => x.wrongPct!);
    assert.deepEqual(byPct, [...byPct].sort((a, b) => b - a));
    const byAttempts = (await getInsightRows(base({ tab: "attempted" }), r)).rows.map((x) => x.attempts);
    assert.deepEqual(byAttempts, [...byAttempts].sort((a, b) => b - a));
    assert.equal(byAttempts[0], Math.max(...raw.map((x) => x.attempts)));
  });

  await check("pagination: page 2 continues page 1 without overlap; Top 50 == pages 1-2 order", async () => {
    const p1 = (await getInsightRows(f, r)).rows.map((x) => x.id);
    const p2 = (await getInsightRows({ ...f, page: 2 }, r)).rows.map((x) => x.id);
    assert.equal(new Set([...p1, ...p2]).size, p1.length + p2.length);
    const top = await getTopQuestionIds(f, r, 50);
    assert.deepEqual(top, [...p1, ...p2].slice(0, 50));
    assert.deepEqual(await getTopQuestionIds(f, r, 10), p1.slice(0, 10));
  });

  await check("filters (exam, subject, test type, difficulty) match raw", async () => {
    const sample = await prisma.$queryRawUnsafe<{ examId: string; subjectId: string; testType: string; difficulty: string }[]>(
      `SELECT q."examId", q."subjectId", t."testType"::text "testType", q.difficulty::text difficulty FROM "Answer" a JOIN "TestAttempt" t ON t.id=a."attemptId" JOIN "Question" q ON q.id=a."questionId"
       WHERE t.status='SUBMITTED' AND a."isCorrect" IS NOT NULL AND t."submittedAt" >= $1 LIMIT 1`,
      r.from
    );
    if (sample.length === 0) return;
    const s = sample[0];
    const fx = base({ examId: s.examId, subjectId: s.subjectId, testType: s.testType, difficulty: s.difficulty });
    const o = await getInsightOverview(fx, r);
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM "Answer" a JOIN "TestAttempt" t ON t.id=a."attemptId" JOIN "Question" q ON q.id=a."questionId"
       WHERE t.status='SUBMITTED' AND a."isCorrect" IS NOT NULL AND t."submittedAt" >= $1 AND t."submittedAt" < $2
         AND q."examId"=$3 AND q."subjectId"=$4 AND t."testType"::text=$5 AND q.difficulty::text=$6`,
      r.from,
      r.to,
      s.examId,
      s.subjectId,
      s.testType,
      s.difficulty
    );
    assert.equal(o.answered, n);
    assert.ok(n > 0);
  });

  await check("Today / Yesterday windows equal raw IST-day counts", async () => {
    for (const range of ["today", "yesterday", "7d"] as const) {
      const fx = base({ range });
      const rx = resolveRange(fx);
      const o = await getInsightOverview(fx, rx);
      assert.equal(o.answered, (await rawStats(rx.from, rx.to, 1)).reduce((s, x) => s + x.attempts, 0), range);
    }
  });

  await check("Most Reported / Most Saved / Most Asked on AI match raw groupings", async () => {
    const rep = await getInsightRows(base({ tab: "reported" }), r);
    const rawRep = await prisma.reportedQuestion.groupBy({ by: ["questionId"], where: { createdAt: { gte: r.from, lt: r.to } }, _count: { _all: true } });
    assert.equal(rep.total, rawRep.length);
    for (const row of rep.rows) assert.equal(row.reports, rawRep.find((x) => x.questionId === row.id)!._count._all);

    const sav = await getInsightRows(base({ tab: "saved" }), r);
    const rawSav = await prisma.savedQuestion.groupBy({ by: ["questionId"], where: { createdAt: { gte: r.from, lt: r.to } }, _count: { _all: true } });
    assert.equal(sav.total, rawSav.length);
    for (const row of sav.rows) assert.equal(row.saves, rawSav.find((x) => x.questionId === row.id)!._count._all);

    const ai = await getInsightRows(base({ tab: "ai" }), r);
    const views = await prisma.studentActivity.findMany({ where: { activity: "AI_EXPLANATION_VIEWED", createdAt: { gte: r.from, lt: r.to } }, select: { metadata: true } });
    const counts = new Map<string, number>();
    for (const v of views) {
      const id = (v.metadata as { questionId?: string } | null)?.questionId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const row of ai.rows) assert.equal(row.aiViews, counts.get(row.id), row.code);
    if (ai.rows.length > 1) assert.ok(ai.rows[0].aiViews! >= ai.rows[ai.rows.length - 1].aiViews!);
  });

  await check("Copy Top 20 uses the canonical stored correct option and exact text", async () => {
    const ids = await getTopQuestionIds(f, r, 20);
    if (ids.length === 0) return;
    const prep = await prepareQuestionCopy({ ids, filters: f, range: r, blockSize: 10, includeExplanation: false });
    const questions = await prisma.question.findMany({ where: { id: { in: ids } }, include: { options: true } });
    let n = 0;
    const text = prep.blocks.map((b) => b.text).join("\n");
    for (const id of ids) {
      const qq = questions.find((x) => x.id === id)!;
      const correct = qq.options.filter((o) => o.isCorrect);
      if (correct.length !== 1) {
        assert.ok(prep.excluded.some((e) => e.id === id), `${qq.code} excluded`);
        continue;
      }
      n++;
      const block = text.split(/\nQ\d+\. /).find((chunk) => chunk.includes(`Correct Answer: ${correct[0].label}.`) && chunk.startsWith(qq.text.slice(0, 20)));
      if (!/<[a-z]/i.test(qq.text)) assert.ok(text.includes(`. ${qq.text}\n`), `${qq.code} exact text`);
      assert.ok(block || /<[a-z]/i.test(qq.text), `${qq.code} has its own correct answer line`);
    }
    assert.equal(prep.includedCount, n);
    assert.ok(!/@|\+91|studentId/i.test(text.replace(/MockTestSeries\.in/g, "")), "no student identifiers");
  });
}

async function partC() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.includes("qiverify")) {
    console.log("Part C — skipped (needs a scratch DB whose name contains 'qiverify')");
    return;
  }
  console.log(`Part C — fixtures on scratch DB ${dbName}`);

  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" } });
  const subject = await prisma.subject.findFirstOrThrow({ where: { examLinks: { some: { examId: exam.id } } } });
  const students = await prisma.student.findMany({ take: 12, select: { id: true } });
  assert.ok(students.length >= 6, "need students in the scratch copy");

  const mk = async (code: string, correctLabels: string[], extra: { imageUrl?: string; explanation?: string } = {}) =>
    prisma.question.create({
      data: {
        code,
        examId: exam.id,
        subjectId: subject.id,
        text: `QI fixture ${code}: which is right?`,
        imageUrl: extra.imageUrl ?? null,
        status: "PUBLISHED",
        options: { create: ["A", "B", "C", "D"].map((label, i) => ({ label, text: `${code} opt ${label}`, order: i, isCorrect: correctLabels.includes(label) })) },
        ...(extra.explanation ? { aiExplanation: { create: { content: { concept: extra.explanation }, model: "fixture", status: "COMPLETED" } } } : {}),
      },
      include: { options: true },
    });

  const good = await mk("QIFIX GOOD", ["C"], { explanation: "C is right because of the fixture." });
  const image = await mk("QIFIX IMAGE", ["B"], { imageUrl: "/storage/question-images/qifix.png" });
  const broken = await mk("QIFIX NOKEY", []);
  const changed = await mk("QIFIX CHANGED", ["A"]);

  // One submitted attempt per student containing every fixture, answered from a script that mimics the engine's final state.
  const now = new Date();
  for (const [i, s] of students.slice(0, 6).entries()) {
    const attempt = await prisma.testAttempt.create({
      data: { studentId: s.id, sourceType: "CUSTOM_MODULE", testType: "CUSTOM_MODULE", examId: exam.id, durationMinutes: 10, totalQuestions: 4, status: "SUBMITTED", submittedAt: now },
    });
    for (const [j, qq] of [good, image, broken, changed].entries()) {
      const snapKey = qq.id === changed.id ? "D" : (qq.options.find((o) => o.isCorrect)?.label ?? "");
      const tq = await prisma.testAttemptQuestion.create({
        data: { attemptId: attempt.id, questionId: qq.id, order: j, questionSnapshot: { code: qq.code, text: qq.text, options: [], correctLabel: snapKey } },
      });
      // Student i answers: good → C for i<2 else A (4/6 wrong); 6th student skips everything.
      const skipped = i === 5;
      const label = skipped ? null : qq.id === good.id ? (i < 2 ? "C" : "A") : "B";
      await prisma.answer.create({
        data: {
          attemptId: attempt.id,
          attemptQuestionId: tq.id,
          studentId: s.id,
          questionId: qq.id,
          selectedOptionLabel: label,
          status: label ? "ANSWERED" : "UNANSWERED",
          isCorrect: label ? label === snapKey : null,
          answeredAt: label ? now : null,
          saveSeq: 5,
        },
      });
    }
  }
  await prisma.reportedQuestion.createMany({
    data: [
      { studentId: students[0].id, questionId: good.id, reportType: "WRONG_ANSWER" },
      { studentId: students[1].id, questionId: good.id, reportType: "WRONG_QUESTION" },
      { studentId: students[1].id, questionId: good.id, reportType: "WRONG_ANSWER" },
    ],
  });

  const f = parseInsightFilters({ range: "today", min: "1", examId: exam.id, subjectId: subject.id });
  const r = resolveRange(f);

  await check("fixture stats: skipped answers excluded, wrong % = wrong / answered", async () => {
    const { rows } = await getInsightRows({ ...f }, r);
    const g = rows.find((x) => x.id === good.id)!;
    assert.deepEqual([g.attempts, g.correct, g.wrong], [5, 2, 3]);
    assert.equal(g.wrongPct, 60);
    assert.equal(g.reports, 3);
  });

  await check("flags: DATA ISSUE, image required + public link, answer key changed", async () => {
    const { rows } = await getInsightRows({ ...f }, r);
    assert.equal(rows.find((x) => x.id === broken.id)!.keyIssue, "NO_CORRECT_OPTION");
    const im = rows.find((x) => x.id === image.id)!;
    assert.ok(im.hasImage && im.imageLink === "https://mocktestseries.in/storage/question-images/qifix.png");
    assert.equal(rows.find((x) => x.id === changed.id)!.keyChanged, true);
    assert.equal(rows.find((x) => x.id === good.id)!.keyChanged, false);
  });

  await check("Most Reported: count, unique reporters, reasons", async () => {
    const { rows } = await getInsightRows({ ...f, tab: "reported" }, r);
    const g = rows.find((x) => x.id === good.id)!;
    assert.equal(g.reports, 3);
    assert.equal(g.reporters, 2);
    assert.deepEqual([...g.reportTypes!].sort(), ["WRONG_ANSWER", "WRONG_QUESTION"]);
  });

  await check("copy: broken excluded, explanation from stored content, image note, key-changed warning", async () => {
    const prep = await prepareQuestionCopy({ ids: [good.id, broken.id, image.id, changed.id], filters: f, range: r, blockSize: 0, includeExplanation: true });
    assert.deepEqual(prep.excluded.map((e) => e.code), ["QIFIX NOKEY"]);
    assert.equal(prep.includedCount, 3);
    const t = prep.blocks[0].text;
    assert.ok(t.includes("Q1. QI fixture QIFIX GOOD") && t.includes("✅ Correct Answer: C. QIFIX GOOD opt C") && t.includes("📊 60% students answered incorrectly."));
    assert.ok(t.includes("💡 Explanation: C is right because of the fixture."));
    assert.ok(t.includes("Q2. QI fixture QIFIX IMAGE") && t.includes("🖼 This question has an image"));
    assert.ok(t.includes("Q3. QI fixture QIFIX CHANGED") && t.includes("✅ Correct Answer: A. QIFIX CHANGED opt A"));
    assert.deepEqual(prep.imageCodes, ["QIFIX IMAGE"]);
    assert.deepEqual(prep.keyChangedCodes, ["QIFIX CHANGED"]);
    assert.deepEqual(prep.missingExplanationCodes, ["QIFIX IMAGE", "QIFIX CHANGED"]);
    assert.ok(t.startsWith("🔥 MOST MISSED QUESTIONS TODAY\nRUHS Medical Officer 2026 | MockTestSeries.in"), t.split("\n").slice(0, 2).join(" / "));
  });

  await check("zero-result date range", async () => {
    const fx = parseInsightFilters({ range: "custom", from: "2021-01-01", to: "2021-01-02", min: "1" });
    const rx = resolveRange(fx);
    const o = await getInsightOverview(fx, rx);
    assert.equal(o.answered, 0);
    assert.equal(o.accuracy, null);
    assert.deepEqual(await getInsightRows(fx, rx), { rows: [], total: 0 });
  });
}

async function main() {
  await partA();
  await partB();
  await partC();
  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
