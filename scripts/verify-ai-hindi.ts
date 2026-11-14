/**
 * FSO bilingual AI: Hindi Ask AI explanations, explanation styles and AI Question Variants follow the question's
 * language; English (RUHS MO) prompts and cache rows are unchanged. DISPOSABLE database only, loopback mock
 * OpenRouter (never a real provider).
 *
 *   DATABASE_URL=<scratch mts_*> PG_POOL_MAX=3 NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-hindi.ts
 */
import assert from "node:assert/strict";

const PORT = 3297;
process.env.OPENROUTER_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FX_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Scratch (mts_*) database only.");
  process.exit(2);
}

let failures = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}  → ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { startMockOpenRouter, mockKey } = await import("./mock-openrouter.mjs");
  const lang = await import("@/lib/ai-language");
  const validation = await import("@/lib/ai-variant-validation");
  const mock = await startMockOpenRouter(PORT);
  const stats = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()) as { chat: number; prompts: string[] };
  const created: string[] = [];

  console.log("A. Language decision (pure)");
  await check("English question → en (even if Hindi requested without a Hindi version)", () => {
    assert.equal(lang.resolveAiLanguage({ text: "Which vitamin is fat soluble?", textHi: null }, "hi"), "en");
    assert.equal(lang.resolveAiLanguage({ text: "Which vitamin is fat soluble?" }, undefined), "en");
  });
  await check("bilingual question: Hindi only when the student reads it in Hindi", () => {
    const q = { text: "Which vitamin is fat soluble?", textHi: "कौन सा विटामिन वसा में घुलनशील है?" };
    assert.equal(lang.resolveAiLanguage(q, "hi"), "hi");
    assert.equal(lang.resolveAiLanguage(q, "en"), "en");
    assert.equal(lang.resolveAiLanguage(q, "xx"), "en");
  });
  await check("Hindi-only question (incl. English technical terms) → hi whatever is requested", () => {
    assert.equal(lang.resolveAiLanguage({ text: "खाद्य सुरक्षा अधिनियम (FSSA) 2006 की धारा 3 में क्या परिभाषित है?" }, "en"), "hi");
    assert.equal(lang.isMostlyHindi("Vitamin D (विटामिन)"), false, "mostly English stays English");
  });
  await check("variant candidate: Hindi block kept only when complete; correctness comes from the English options", () => {
    const base = { text: "Q", options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `o${l}`, isCorrect: l === "B" })), explanation: "e", optionAnalysis: {} };
    const ok = validation.validateCandidate({ ...base, hi: { text: "प्र", options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `वि${l}` })), explanation: "हि", optionAnalysis: { A: "गलत" } } });
    assert.equal(ok?.hi?.options.length, 4);
    const half = validation.validateCandidate({ ...base, hi: { text: "प्र", options: [{ label: "A", text: "x" }] } });
    assert.ok(half && !half.hi, "incomplete Hindi dropped, English variant kept");
  });

  // ---- fixtures: clone a published single-correct question three times (English / bilingual / Hindi-only)
  const tpl = await prisma.question.findFirstOrThrow({
    where: { status: "PUBLISHED", questionType: "SINGLE_CORRECT", parentQuestionId: null, options: { some: { isCorrect: true } } },
    include: { options: { orderBy: { order: "asc" } } },
  });
  const tag = Date.now().toString(36);
  const mk = async (suffix: string, text: string, textHi: string | null, opts: [string, string | null][]) => {
    const q = await prisma.question.create({
      data: {
        code: `AIHI-${tag}-${suffix}`,
        examId: tpl.examId,
        subjectId: tpl.subjectId,
        topicId: tpl.topicId,
        subTopicId: tpl.subTopicId,
        difficulty: tpl.difficulty,
        status: "PUBLISHED",
        questionType: "SINGLE_CORRECT",
        text,
        textHi,
        options: { create: opts.map(([t, th], i) => ({ label: "ABCD"[i], text: t, textHi: th, isCorrect: i === 1, order: i })) },
      },
    });
    created.push(q.id);
    return q;
  };
  const en = await mk("EN", "Which vitamin is fat soluble?", null, [["Vitamin C", null], ["Vitamin D", null], ["Vitamin B1", null], ["Vitamin B12", null]]);
  const bi = await mk("BI", "Which preservative is permitted in jam?", "जैम में कौन सा परिरक्षक अनुमत है?", [
    ["Formalin", "फॉर्मेलिन"],
    ["Sodium benzoate", "सोडियम बेंजोएट"],
    ["Boric acid", "बोरिक एसिड"],
    ["Urea", "यूरिया"],
  ]);
  const hiOnly = await mk("HI", "खाद्य सुरक्षा अधिनियम कब लागू हुआ?", null, [["2005", null], ["2006", null], ["2010", null], ["2011", null]]);

  // ---- route Student Ask AI (medical feature) to the loopback mock
  const settings = await import("@/lib/ai-engine/settings");
  const cfg = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  await settings.saveOpenRouterKey(mockKey("valid"));
  await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true, 'lastTest', jsonb_build_object('ok', true, 'category', 'ok', 'message', 'ok', 'at', '2026-01-01T00:00:00Z')) WHERE "key" = 'api.openrouter'`;
  await catalog.syncCatalog();
  await prisma.aiModel.update({ where: { id: "mockai/mid" }, data: { approved: true, medicallyApproved: true } });
  await settings.saveFeatureConfig("explanation", cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter" }));

  const { getOrCreateExplanation } = await import("@/lib/ai-explanation");
  const { getOrCreateExplanationVariant } = await import("@/lib/ai-explanation-variants");

  console.log("B. Ask AI explanation");
  await check("English question: English prompt, cached in AIExplanation (no Hindi instruction)", async () => {
    const before = (await stats()).chat;
    await getOrCreateExplanation(en.id);
    const s = await stats();
    assert.equal(s.chat, before + 1);
    assert.ok(!s.prompts.at(-1)!.includes("LANGUAGE:"), "English prompt must not carry the Hindi instruction");
    assert.ok(s.prompts.at(-1)!.includes("Which vitamin is fat soluble?"));
    assert.equal(await prisma.aIExplanationVariant.count({ where: { questionId: en.id } }), 0);
  });
  await check("bilingual question read in Hindi: Hindi prompt with the Hindi text, own cache row default@hi", async () => {
    await getOrCreateExplanation(bi.id); // the English explanation exists first …
    const english = await prisma.aIExplanation.findUniqueOrThrow({ where: { questionId: bi.id } });
    await getOrCreateExplanationVariant(bi.id, "default", "hi");
    const p = (await stats()).prompts.at(-1)!;
    assert.ok(p.includes("LANGUAGE:") && p.includes("Devanagari"), "Hindi output instruction");
    assert.ok(p.includes("जैम में कौन सा परिरक्षक अनुमत है?") && p.includes("सोडियम बेंजोएट"), "Hindi question + options sent");
    assert.ok(p.includes('"optionAnalysis"'), "why the other options are wrong is always asked for in Hindi");
    const row = await prisma.aIExplanationVariant.findUniqueOrThrow({ where: { questionId_variantId: { questionId: bi.id, variantId: "default@hi" } } });
    assert.equal(row.status, "COMPLETED");
    const after = await prisma.aIExplanation.findUniqueOrThrow({ where: { questionId: bi.id } });
    assert.equal(after.updatedAt.getTime(), english.updatedAt.getTime(), "… and is never overwritten by the Hindi one");
  });
  await check("cache: second Hindi + English request = 0 provider calls; languages never cross", async () => {
    const before = (await stats()).chat;
    const hi = await getOrCreateExplanationVariant(bi.id, "default", "hi");
    const eng = await getOrCreateExplanation(bi.id);
    assert.equal((await stats()).chat, before);
    assert.notEqual(hi.id, eng.id);
  });
  await check("explanation style (Simpler) in Hindi: separate key simpler@hi, English simpler untouched", async () => {
    await getOrCreateExplanationVariant(bi.id, "simpler", "en");
    assert.ok(!(await stats()).prompts.at(-1)!.includes("LANGUAGE:"));
    await getOrCreateExplanationVariant(bi.id, "simpler", "hi");
    assert.ok((await stats()).prompts.at(-1)!.includes("LANGUAGE:"));
    const keys = (await prisma.aIExplanationVariant.findMany({ where: { questionId: bi.id }, select: { variantId: true } })).map((r) => r.variantId).sort();
    assert.deepEqual(keys, ["default@hi", "simpler", "simpler@hi"]);
  });
  await check("stale flag (question edited) covers the Hindi rows too", async () => {
    const { flagExplanationStaleIfExists } = await import("@/lib/ai-explanation");
    await flagExplanationStaleIfExists(bi.id);
    assert.equal(await prisma.aIExplanationVariant.count({ where: { questionId: bi.id, isStale: false } }), 0);
  });

  console.log("C. AI Question Variants (scripted generator)");
  const { ensureQuestionVariants, getActiveVariants } = await import("@/lib/ai-variant");
  const prompts: string[] = [];
  const fake = (withHi: boolean, lead: string) => async (prompt: string) => {
    prompts.push(prompt);
    const n = Number(/Write (\d+) NEW/.exec(prompt)?.[1] ?? 1);
    const variants = Array.from({ length: n }, (_, i) => ({
      text: `${lead} variant ${i + 1} about ${tag}`,
      options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `${lead} option ${l}${i}`, isCorrect: l === "C" })),
      explanation: `${lead} explanation ${i}`,
      optionAnalysis: { A: "x", B: "y", D: "z" },
      ...(withHi
        ? { hi: { text: `हिंदी प्रश्न ${i + 1} ${tag}`, options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `हिंदी विकल्प ${l}${i}` })), explanation: `हिंदी व्याख्या ${i}`, optionAnalysis: { A: "गलत" } } }
        : {}),
    }));
    return { text: JSON.stringify({ variants }), provider: "mock", model: "mock" } as never;
  };
  await check("English source: prompt unchanged (no LANGUAGE / BILINGUAL), English variants only", async () => {
    const r = await ensureQuestionVariants(en.id, { target: 2, generate: fake(false, "Eng") });
    assert.equal(r.generatedNow, 2);
    const p = prompts.at(-1)!;
    assert.ok(!p.includes("LANGUAGE:") && !p.includes("BILINGUAL"), "English prompt byte-identical in behaviour");
    const rows = await prisma.question.findMany({ where: { parentQuestionId: en.id }, include: { options: true } });
    assert.ok(rows.every((q) => q.textHi === null && q.options.every((o) => o.textHi === null)));
  });
  await check("bilingual source: one generation stores English + Hindi (textHi, option textHi, default@hi explanation)", async () => {
    const r = await ensureQuestionVariants(bi.id, { target: 2, generate: fake(true, "Bi") });
    assert.equal(r.generatedNow, 2);
    const p = prompts.at(-1)!;
    assert.ok(p.includes("BILINGUAL") && p.includes("जैम में कौन सा परिरक्षक अनुमत है?"), "asks for the Hindi version, shows the official Hindi source");
    const rows = await prisma.question.findMany({ where: { parentQuestionId: bi.id }, include: { options: true } });
    assert.ok(rows.every((q) => q.textHi?.startsWith("हिंदी प्रश्न") && q.options.length === 4 && q.options.every((o) => o.textHi?.startsWith("हिंदी विकल्प"))));
    assert.ok(rows.every((q) => q.options.filter((o) => o.isCorrect).length === 1 && q.options.find((o) => o.isCorrect)!.label === "C"), "one correct answer, same in both languages");
    assert.equal(await prisma.aIExplanationVariant.count({ where: { questionId: { in: rows.map((q) => q.id) }, variantId: "default@hi" } }), 2);
  });
  await check("variants view: Hindi reader sees Hindi, English reader sees English (same rows)", async () => {
    const hi = await getActiveVariants(bi.id, "hi");
    const eng = await getActiveVariants(bi.id, "en");
    assert.equal(hi.length, 2);
    assert.ok(hi.every((v) => v.text.startsWith("हिंदी प्रश्न") && v.options.every((o) => o.text.startsWith("हिंदी विकल्प")) && v.explanation.startsWith("हिंदी व्याख्या")));
    assert.ok(eng.every((v) => v.text.startsWith("Bi variant") && v.explanation.startsWith("Bi explanation")));
    assert.deepEqual(hi.map((v) => v.id), eng.map((v) => v.id));
    assert.deepEqual(hi.map((v) => v.options.find((o) => o.isCorrect)?.label), eng.map((v) => v.options.find((o) => o.isCorrect)?.label));
  });
  await check("Hindi-only source: Hindi instruction sent; Hindi explanation cached for Ask AI on the variant", async () => {
    const r = await ensureQuestionVariants(hiOnly.id, { target: 1, generate: fake(false, "हिंदी") });
    assert.equal(r.generatedNow, 1);
    assert.ok(prompts.at(-1)!.includes("LANGUAGE:") && !prompts.at(-1)!.includes("BILINGUAL"));
    const v = await prisma.question.findFirstOrThrow({ where: { parentQuestionId: hiOnly.id } });
    assert.equal(await prisma.aIExplanationVariant.count({ where: { questionId: v.id, variantId: "default@hi" } }), 1);
  });
  await check("English-only variant rows read in Hindi fall back to their stored text (never blank)", async () => {
    const v = await getActiveVariants(en.id, "hi");
    assert.ok(v.length === 2 && v.every((x) => x.text.startsWith("Eng variant")));
  });

  // ---- cleanup (variants first: they reference the sources)
  const variantIds = (await prisma.question.findMany({ where: { parentQuestionId: { in: created } }, select: { id: true } })).map((q) => q.id);
  await prisma.question.deleteMany({ where: { id: { in: variantIds } } });
  await prisma.question.deleteMany({ where: { id: { in: created } } });
  mock.close?.();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nALL AI HINDI CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
