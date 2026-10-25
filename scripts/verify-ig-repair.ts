/**
 * Instagram Studio repair (characters, Question Bank read-only, Fix This Error / Master
 * Fix, AI suggestions, medical review) — library regression.
 *
 *   set -a; . <secret-free env with an *igstudio* scratch DB>; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-repair.ts
 *
 * Part A is pure (plus the renderer, network blocked). Part B creates its own
 * IGFIX-REPAIR-* questions on the fixture exam and removes them afterwards;
 * it refuses to run unless the database name contains "igstudio". No AI
 * provider is ever called: generators are stubs.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { normalizeEquivalent } from "@/lib/instagram/text-normalize";
import { isDrawable, normalizeForSlides, renderable, unsupportedChars } from "@/lib/instagram/glyphs";
import { runQualityGate, medicalTextHash, type QualityInput } from "@/lib/instagram/quality";
import { adviseIssue, checksStatus, passedChecks, planFixes, type FixContext } from "@/lib/instagram/fixes";
import { parseAiResponse } from "@/lib/instagram/ai-core";
import { generateContent } from "@/lib/instagram/ai";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { SAMPLE_INPUT, SAMPLE_SETTINGS } from "@/lib/instagram/sample";
import { checkContentInput } from "@/lib/instagram/validate";
import { defaultDesign, normalizeContent, normalizeDesign, SLIDE_HEIGHT, SLIDE_WIDTH, type PostContent } from "@/lib/instagram/types";
import { DIFFICULTY_LABELS, LEGACY_DIFFICULTY_CODES, legacyDifficultyNote, parseDifficulty } from "@/lib/question-difficulty";

// ---- Network guard (Satori would fetch missing glyphs / emoji) ---------------------
const fetches: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("data:")) return realFetch(input, init);
  fetches.push(url);
  throw new Error("network disabled in tests");
}) as typeof fetch;

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

const NBH = "‑"; // non-breaking hyphen (the "minus" in the screenshots)
const MINUS = "−";
const snap = SAMPLE_INPUT.snapshot;
const goodContent = (): PostContent => ({ ...SAMPLE_INPUT.content, caption: "Can you solve this?\nComment your answer and save this post.", hashtags: ["#RUHSMO", "#Pharmacology"] });
const gateInput = (over: Partial<QualityInput> = {}): QualityInput => ({
  snapshot: snap,
  content: goodContent(),
  design: defaultDesign(),
  series: "PYQ",
  seriesStats: null,
  questionNumber: 12,
  questionNumberVerified: true,
  currentHash: "h",
  snapshotHash: "h",
  follow: { instagramHandle: "mocktestseries.in", showInstagram: true, telegramUrl: "https://t.me/x", showTelegram: true },
  allowedDomains: ["mocktestseries.in", "t.me", "instagram.com"],
  unsupportedChars,
  settingsTexts: [],
  ...over,
});
const fixCtx = (input: QualityInput, over: Partial<FixContext> = {}): FixContext => ({
  snapshot: input.snapshot,
  content: input.content,
  design: input.design,
  series: input.series,
  normalize: normalizeForSlides,
  questionEditHref: "/admin/questions?tab=add&id=x",
  ...over,
});

async function partA() {
  console.log("Part A — pure rules + renderer");

  await check("normalizer: U+2011 non-breaking hyphen → '-' (equivalent); minus sign, en and em dash are kept", () => {
    const r = normalizeForSlides(`X${NBH}ray, soft${NBH}tissue; pH 7.4 ${MINUS} 0.2; 2–3 days — early`);
    assert.equal(r.text, `X-ray, soft-tissue; pH 7.4 ${MINUS} 0.2; 2–3 days — early`);
    assert.deepEqual(r.remaining, []);
    assert.ok(r.replacements.every((x) => x.cls === "equivalent"));
    assert.ok(isDrawable(0x2212) && isDrawable(0x2013) && isDrawable(0x2014), "the fonts draw −, – and —");
    assert.equal(normalizeEquivalent(`X${NBH}ray`), "X-ray");
  });

  await check("normalizer: contextual notation only when allowed — Na⁺ → Na+, 10⁻⁶ → 10^-6, Ca²⁺ → Ca2+, HCO₃⁻ keeps ₃, ⇒ → →", () => {
    const t = "Na⁺ and Ca²⁺; dose 10⁻⁶ M; HCO₃⁻ ⇒ alkalosis; H₂O";
    const safe = normalizeForSlides(t, false);
    assert.equal(safe.text, t, "contextual characters are never rewritten silently");
    assert.ok(safe.remaining.includes("⁺") && safe.remaining.includes("⁻"));
    const fixed = normalizeForSlides(t, true);
    assert.equal(fixed.text, "Na+ and Ca2+; dose 10^-6 M; HCO₃- → alkalosis; H₂O");
    assert.deepEqual(fixed.remaining, []);
    assert.ok(fixed.replacements.some((x) => x.cls === "contextual" && x.to === "^-6"));
  });

  await check("normalizer: soft hyphen / odd spaces dropped; decorative leading emoji removed only in Fix mode; ⇌ and mid-text emoji have no safe replacement", () => {
    assert.equal(normalizeForSlides("hyper\u00adkalaemia\u2009now").text, "hyperkalaemia\u2009now", "soft hyphen dropped; a drawable thin space is kept");
    const r = normalizeForSlides("✅ MRI first\n❌ X-ray alone", true);
    assert.equal(r.text, "MRI first\nX-ray alone");
    const bad = normalizeForSlides("A ⇌ B 😀 ok", true);
    assert.deepEqual(bad.remaining.sort(), ["⇌", "😀"].sort());
  });

  await check("renderable(): U+2011 drawn as '-' (no □); undrawable characters become □ in previews only", () => {
    assert.equal(renderable(`X${NBH}ray`), "X-ray");
    assert.equal(renderable("A ⇌ B"), "A □ B");
    assert.deepEqual(unsupportedChars(`X${NBH}ray ${MINUS}`), []);
  });

  await check("gate: the screenshot drafts (U+2011 in Explanation / Quick Revision) no longer block; a real unsupported glyph still does", () => {
    const c = { ...goodContent(), explanation: `MRI shows marrow edema early; X${NBH}ray is insensitive early.`, quickRevision: [`MRI detects marrow edema before X${NBH}ray changes.`] };
    assert.ok(!runQualityGate(gateInput({ content: c })).some((i) => i.code.startsWith("GLYPHS")));
    const c2 = { ...goodContent(), explanation: "Loss of Na⁺ ⇌ water", quickRevision: ["K⁺ high"] };
    const issues = runQualityGate(gateInput({ content: c2 }));
    const g = issues.filter((i) => i.code.startsWith("GLYPHS"));
    assert.deepEqual(g.map((i) => i.code).sort(), ["GLYPHS:Explanation", "GLYPHS:Quick Revision"]);
    assert.ok(g.every((i) => i.severity === "error"));
    assert.match(g[0].message, /U\+/);
  });

  await check("advice: glyph fix is automatic when every character has a safe replacement, else needs the admin (with Generate with AI)", () => {
    const c = { ...goodContent(), explanation: "Loss of Na⁺ ⇌ water", quickRevision: ["K⁺ high"] };
    const input = gateInput({ content: c });
    const issues = runQualityGate(input);
    const exp = adviseIssue(issues.find((i) => i.code === "GLYPHS:Explanation")!, fixCtx(input));
    const qr = adviseIssue(issues.find((i) => i.code === "GLYPHS:Quick Revision")!, fixCtx(input));
    assert.equal(exp.category, "admin");
    assert.deepEqual(exp.ai?.fields, ["explanation"]);
    assert.equal(qr.category, "auto");
    assert.equal(qr.action.kind, "fix");
  });

  await check("glyphs in the question stem / options are never 'fixed' here — they point to the Question Bank", () => {
    const input = gateInput({ snapshot: { ...snap, text: `${snap.text} (Na⁺)` } });
    const issue = runQualityGate(input).find((i) => i.code === "GLYPHS:Question")!;
    assert.ok(issue);
    const a = adviseIssue(issue, fixCtx(input));
    assert.equal(a.category, "admin");
    assert.equal(a.action.kind, "link");
    const plan = planFixes(runQualityGate(input), fixCtx(input), "all");
    assert.equal(plan.changes.filter((ch) => ch.codes.includes("GLYPHS:Question")).length, 0);
  });

  await check("Master Fix plan: groups by root cause; fixes characters, picks the existing hook, finds a fitting text size; never touches the snapshot", () => {
    const c: PostContent = { ...goodContent(), hookText: "", quickRevision: ["K⁺ high", "Na⁺ low"], clinicalPearl: `Early MRI ${NBH} T2 bright marrow` };
    const design = { ...defaultDesign(), modules: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "PEARL_REVISION", "FOLLOW"] as never, slideCount: 6 };
    const input = gateInput({ content: c, design });
    const issues = runQualityGate(input);
    assert.ok(issues.some((i) => i.code === "SLIDE_MISSING:0"));
    const plan = planFixes(issues, fixCtx(input), "all");
    assert.equal(plan.content.hookText, c.hooks[0].text);
    assert.deepEqual(plan.content.quickRevision, ["K+ high", "Na+ low"]);
    assert.equal(plan.content.clinicalPearl, "Early MRI - T2 bright marrow", "equivalent characters are stored cleanly by Master Fix too");
    assert.ok(plan.changes.some((ch) => ch.kind === "hook") && plan.changes.some((ch) => ch.kind === "characters-contextual"));
    const after = runQualityGate(gateInput({ content: plan.content, design: plan.design }));
    assert.ok(!after.some((i) => i.code.startsWith("GLYPHS") || i.code === "SLIDE_MISSING:0"));
    // Fix This Error = only that issue.
    const one = planFixes(issues, fixCtx(input), ["SLIDE_MISSING:0"]);
    assert.deepEqual(one.changes.map((x) => x.kind), ["hook"]);
    assert.deepEqual(one.content.quickRevision, c.quickRevision);
  });

  await check("overflow: a smaller text size is proposed only when it makes the slide fit (never below ×0.85)", () => {
    const long = "Ethosuximide blocks T-type calcium channels in thalamic neurons, which generate the 3 Hz spike-and-wave discharges. ".repeat(6).slice(0, 560);
    const input = gateInput({ content: { ...goodContent(), explanation: long }, design: { ...defaultDesign(), bodyScale: 1.25 } });
    const issues = runQualityGate(input);
    const ov = issues.find((i) => i.code.startsWith("SLIDE_OVERFLOW"));
    if (!ov) return; // layout fits even at ×1.25 — nothing to propose
    const a = adviseIssue(ov, fixCtx(input));
    const plan = planFixes(issues, fixCtx(input), [ov.code]);
    if (a.category === "auto") {
      assert.ok(plan.design.bodyScale < 1.25 && plan.design.bodyScale >= 0.85);
      assert.ok(!runQualityGate(gateInput({ content: input.content, design: plan.design })).some((i) => i.code === ov.code));
    } else assert.equal(plan.changes.length, 0);
    assert.ok(a.ai && a.ai.instruction && /Keep every medical fact/.test(a.ai.instruction));
  });

  await check("difficulty interpretation (read-only, for messages): canonical, every legacy code, unknown values", () => {
    for (const v of ["EASY", "MEDIUM", "HARD", "easy", " Hard "]) assert.equal(parseDifficulty(v).kind, "canonical");
    for (const [code, value] of Object.entries(LEGACY_DIFFICULTY_CODES)) {
      const p = parseDifficulty(code.toLowerCase());
      assert.ok(p.kind === "legacy" || p.kind === "canonical", code);
      if (p.kind === "legacy" || p.kind === "canonical") assert.equal(p.value, value);
    }
    for (const v of ["X", "3", "L", "HIGH", "low", "very hard"]) assert.equal(parseDifficulty(v).kind, "unknown", v);
    assert.equal(parseDifficulty("").kind, "missing");
    assert.equal(DIFFICULTY_LABELS.EASY, "Easy");
  });

  await check("Question Bank importer behaviour is unchanged (E is still reported as not recognized)", async () => {
    const { validateImportRows } = await import("@/lib/bulk-import");
    const row = (difficulty: string) => ({ subject: "Anatomy", questionText: "Q?", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctAnswer: "A", difficulty, status: "PUBLISHED", topic: "T", subTopic: "S", source: "PYQ" }) as never;
    const warn = (d: string) => validateImportRows([row(d)])[0].warnings.filter((w) => /Difficulty/.test(w));
    assert.deepEqual(warn("E"), ['Difficulty "E" not recognized, will default to MEDIUM']);
    assert.deepEqual(warn("EASY"), []);
  });

  await check("legacy review note is parsed for the message only: E → Easy, H → Hard; other reasons are kept", () => {
    assert.deepEqual(legacyDifficultyNote('Difficulty "E" not recognized, will default to MEDIUM'), { original: "E", mapped: "EASY", remainingReason: "" });
    assert.deepEqual(legacyDifficultyNote('Topic not provided; Difficulty "H" not recognized, will default to MEDIUM'), { original: "H", mapped: "HARD", remainingReason: "Topic not provided" });
    assert.equal(legacyDifficultyNote('Difficulty "Z" not recognized, will default to MEDIUM')!.mapped, null);
    assert.equal(legacyDifficultyNote("Imported scan — first letters missing"), null);
  });

  await check("gate: legacy difficulty is reported as a Question Bank warning that Instagram Studio never fixes or writes", () => {
    const s1 = { ...snap, reviewRequired: true, reviewReason: 'Difficulty "E" not recognized, will default to MEDIUM' };
    const issues = runQualityGate(gateInput({ snapshot: s1 }));
    const w = issues.find((i) => i.code === "QB_DIFFICULTY_LEGACY")!;
    assert.ok(w && w.severity === "warning" && /usually means Easy/.test(w.message) && /does not edit the Question Bank/.test(w.message));
    assert.ok(!issues.some((i) => i.code === "QB_REVIEW_REQUIRED"));
    const a = adviseIssue(w, fixCtx(gateInput({ snapshot: s1 })));
    assert.equal(a.category, "admin");
    assert.notEqual(a.action.kind, "fix");
    assert.equal(planFixes(runQualityGate(gateInput({ snapshot: s1 })), fixCtx(gateInput({ snapshot: s1 })), "all").changes.length, 0, "no fix is ever planned for it");
    const s2 = { ...snap, reviewRequired: true, reviewReason: 'Difficulty "Z" not recognized, will default to MEDIUM' };
    assert.ok(runQualityGate(gateInput({ snapshot: s2 })).some((i) => i.code === "QB_DIFFICULTY_UNKNOWN"));
  });

  await check("printed question number: optional warning, admin input, never taken from the stored order", () => {
    const issues = runQualityGate(gateInput({ questionNumber: null, questionNumberVerified: false }));
    const w = issues.find((i) => i.code === "QUESTION_NUMBER_MISSING")!;
    assert.equal(w.severity, "warning");
    assert.match(w.message, /^Optional/);
    const a = adviseIssue(w, fixCtx(gateInput()));
    assert.equal(a.category, "admin");
    assert.equal(a.action.kind, "question-number");
    assert.equal(planFixes(issues, fixCtx(gateInput({ questionNumber: null })), "all").changes.length, 0);
  });

  await check("AI_CONTENT only when AI wrote medical text (caption-only AI → no warning); medical review covers exactly the reviewed text", () => {
    const captionOnly: PostContent = { ...goodContent(), hookText: "", explanation: "", memoryTrick: "", clinicalPearl: "", quickRevision: [], pearls: [], mistakes: [], finalTrick: "", origin: { kind: "ai" } };
    assert.ok(!runQualityGate(gateInput({ content: captionOnly })).some((i) => i.code === "AI_CONTENT"));
    const ai: PostContent = { ...goodContent(), origin: { kind: "ai" }, aiFlags: ["Verify that MRI is the recommended imaging"] };
    const before = runQualityGate(gateInput({ content: ai }));
    assert.ok(before.some((i) => i.code === "AI_CONTENT") && before.some((i) => i.code === "AI_FLAG:0"));
    const reviewed: PostContent = { ...ai, medicalReview: { contentHash: medicalTextHash(ai), reviewerId: "r", reviewerName: "R", at: new Date().toISOString(), note: "", fullReview: true, flags: [{ flag: ai.aiFlags[0], decision: "context", note: "Investigation of choice = MRI" }] } };
    const after = runQualityGate(gateInput({ content: reviewed }));
    assert.ok(!after.some((i) => i.code === "AI_CONTENT" || i.code.startsWith("AI_FLAG")));
    // Any edit voids the review.
    const edited = { ...reviewed, explanation: `${reviewed.explanation} Extra.` };
    assert.ok(runQualityGate(gateInput({ content: edited })).some((i) => i.code === "AI_CONTENT"));
    // A notes-only review leaves the content warning.
    const notesOnly = { ...reviewed, medicalReview: { ...reviewed.medicalReview!, fullReview: false } };
    const n = runQualityGate(gateInput({ content: notesOnly }));
    assert.ok(n.some((i) => i.code === "AI_CONTENT") && !n.some((i) => i.code.startsWith("AI_FLAG")));
    // The status line never claims a review.
    const st = checksStatus(before.filter((i) => i.code.startsWith("AI_")), before.filter((i) => i.code.startsWith("AI_")).map((i) => adviseIssue(i, fixCtx(gateInput()))));
    assert.equal(st.text, "All automatic checks passed. Medical review still required.");
  });

  await check("medical review record is server-owned: Save keeps the server's copy", () => {
    const prev: PostContent = { ...goodContent(), medicalReview: { contentHash: "x", reviewerId: "r", reviewerName: "R", at: "2026-01-01T00:00:00Z", note: "", fullReview: true, flags: [] } };
    const forged = { ...goodContent(), medicalReview: { contentHash: medicalTextHash(goodContent()), reviewerId: "evil", reviewerName: "E", at: "2026-01-01T00:00:00Z", note: "", fullReview: true, flags: [] } };
    const r = checkContentInput(forged, prev);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.medicalReview?.reviewerId, "r");
  });

  await check("passed checks list and status lines", () => {
    const issues = runQualityGate(gateInput());
    const passedList = passedChecks(issues, defaultDesign());
    assert.ok(passedList.includes("All characters drawable") && passedList.includes("Answer key valid"));
    assert.equal(checksStatus([], []).text, "All checks passed.");
  });

  await check("AI ingestion: U+2011 normalized; a response that disagrees with the answer key is still discarded", () => {
    const resp = JSON.stringify({ answerLabel: "B", explanation: `X${NBH}ray is insensitive early.`, confidence: "high", concerns: [] });
    const p = parseAiResponse(resp, snap, ["explanation"], ["mocktestseries.in"]);
    assert.equal(p.patch.explanation, "X-ray is insensitive early.");
    const wrong = parseAiResponse(JSON.stringify({ answerLabel: "C", explanation: "x", confidence: "high" }), snap, ["explanation"], []);
    assert.ok(wrong.fatal && /disagreed with the stored answer key/.test(wrong.fatal));
  });

  await check("renderer: Professional and Handwritten modes draw U+2011, Greek and symbols with bundled fonts only (1080×1350, no network)", async () => {
    const content = { ...goodContent(), explanation: `β${NBH}lactam vs α${NBH}blocker: pH ${MINUS}0.2, 2–3 days — Δ ≈ 5 µg`, quickRevision: [`X${NBH}ray early is normal`, "T₂ bright"] };
    for (const template of ["navy-premium", "hw-doctor"] as const) {
      const design = { ...defaultDesign(template), modules: ["QUESTION", "ANSWER", "PEARL_REVISION", "FOLLOW"] as never, slideCount: 4 };
      for (let i = 0; i < 3; i++) {
        const jpeg = await renderSlideJpeg({ ...SAMPLE_INPUT, content, design, settings: SAMPLE_SETTINGS }, i);
        const m = await sharp(jpeg).metadata();
        assert.equal(`${m.width}x${m.height}`, `${SLIDE_WIDTH}x${SLIDE_HEIGHT}`);
      }
    }
    assert.deepEqual(fetches, [], "Satori never fetched a font/emoji");
  });
}

// ---- Part B — database (scratch only) --------------------------------------------------

async function partB() {
  const db = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!db.includes("igstudio")) {
    console.log(`Part B skipped: database "${db}" is not an igstudio scratch database.`);
    return;
  }
  console.log("Part B — database (scratch)");
  const { createDraft, getPostDto, applyChange } = await import("@/lib/instagram/posts");
  const { previewRepair, applyRepair, recordMedicalReview } = await import("@/lib/instagram/repair");
  const { makeProposal, acceptProposal, allowedKeysFor } = await import("@/lib/instagram/proposals");
  const { hashSource } = await import("@/lib/instagram/snapshot");

  const actor = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "IGFIX-RUHS" } });
  const paper = await prisma.previousYearPaper.findFirstOrThrow({ where: { examId: exam.id, year: 2021 } });
  const template = await prisma.question.findFirstOrThrow({ where: { examId: exam.id, previousYearPaperId: paper.id, status: "PUBLISHED", reviewRequired: false }, select: { subjectId: true, topicId: true } });

  // Question Bank fingerprint: every question, option, taxonomy link and PYQ mapping.
  const qbFingerprint = async () => {
    const rows = await prisma.$queryRaw<{ h: string }[]>`
      SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
        SELECT q.id || q.code || q.text || q.status || q.difficulty || q."reviewRequired" || coalesce(q."reviewReason", '') || q."subjectId" || coalesce(q."topicId", '') || coalesce(q."previousYearPaperId", '') || coalesce(q.explanation, '') || q."updatedAt" AS x FROM "Question" q
        UNION ALL SELECT o.id || o."questionId" || o.text || o."isCorrect" || o.label || o."order" FROM "QuestionOption" o
        UNION ALL SELECT p.id || p.title || p.year FROM "PreviousYearPaper" p) t`;
    return rows[0].h;
  };
  const mkQ = async (code: string, reviewReason: string | null, difficulty: "EASY" | "MEDIUM" | "HARD" = "MEDIUM") =>
    prisma.question.create({
      data: {
        code,
        examId: exam.id,
        subjectId: template.subjectId,
        topicId: template.topicId,
        previousYearPaperId: paper.id,
        text: "What is the imaging of choice for suspected acute osteomyelitis?",
        status: "PUBLISHED",
        difficulty,
        reviewRequired: Boolean(reviewReason),
        reviewReason,
        options: { create: [["A", "CT scan"], ["B", "X-ray"], ["C", "Ultrasonography"], ["D", "MRI"]].map(([label, text], order) => ({ label, text, isCorrect: label === "D", order })) },
      },
    });
  const cleanupQs = async () => {
    const qs = await prisma.question.findMany({ where: { code: { startsWith: "IGFIX-REPAIR-" } }, select: { id: true } });
    const ids = qs.map((q) => q.id);
    await prisma.instagramPost.deleteMany({ where: { questionId: { in: ids } } });
    await prisma.questionOption.deleteMany({ where: { questionId: { in: ids } } });
    await prisma.question.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanupQs();

  try {
    const q = await mkQ("IGFIX-REPAIR-W70", 'Difficulty "E" not recognized, will default to MEDIUM');
    const { post: created } = await createDraft({ questionId: q.id, series: "PYQ", stats: null, actorId: actor.id });
    // The screenshot draft: AI text with U+2011 and a superscript, an AI note, a legacy difficulty, no printed number.
    const aiContent: PostContent = {
      ...created.content,
      hooks: [{ style: "curiosity", text: "Can You Identify the Best Scan for Acute Osteomyelitis?" }],
      hookText: "",
      explanation: `MRI is the imaging of choice for acute osteomyelitis: it shows marrow edema early. X${NBH}ray is insensitive early.`,
      memoryTrick: "MRI = Marrow",
      clinicalPearl: "Early MRI shows T2 bright marrow before radiographs change.",
      quickRevision: [`MRI detects marrow edema before X${NBH}ray changes.`, "Ca²⁺ ⁺ test"],
      caption: "Which scan first?\nComment your answer and save this post.",
      hashtags: ["#Radiology"],
      origin: { kind: "ai", provider: "stub", model: "stub" },
      aiFlags: ["Verify that MRI is indeed the recommended imaging for acute osteomyelitis in the exam syllabus."],
    };
    const design = { ...normalizeDesign(created.design), template: "hw-doctor" as const, modules: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "PEARL_REVISION", "FOLLOW"] as never, slideCount: 6 };
    let post = await applyChange({ postId: created.id, expectedRevision: created.revision, content: aiContent, design, note: "test: AI draft", actorId: actor.id });
    const qbBefore = await qbFingerprint();
    const hashBefore = hashSource({ text: post.snapshot.text, options: post.snapshot.options, paperId: post.snapshot.paperId, examName: post.snapshot.examName, paperYear: post.snapshot.paperYear, paperTitle: post.snapshot.paperTitle });

    await check("reopened draft reproduces the screenshot issues with categories (auto / admin / medical)", async () => {
      post = await getPostDto(post.id);
      const byCode = Object.fromEntries(post.advice.map((a) => [a.code, a.category]));
      assert.equal(byCode["GLYPHS:Quick Revision"], "auto");
      assert.ok(!("GLYPHS:Explanation" in byCode), "U+2011 alone is drawn as '-' and is not an error any more");
      assert.equal(byCode["SLIDE_MISSING:0"], "auto");
      assert.equal(byCode["QB_DIFFICULTY_LEGACY"], "admin", "reported only — never fixed by the studio");
      assert.equal(byCode["QUESTION_NUMBER_MISSING"], "admin");
      assert.equal(byCode["AI_CONTENT"], "medical");
      assert.equal(byCode["AI_FLAG:0"], "medical");
    });

    let preview = await previewRepair(post.id, "all");
    await check("Master Fix preview writes nothing and predicts the result", async () => {
      const again = await getPostDto(post.id);
      assert.equal(again.revision, post.revision);
      assert.ok(preview.changes.length >= 3);
      assert.ok(preview.after.errors < preview.before.errors);
      assert.ok(preview.remaining.some((r) => r.advice.category === "medical"));
      assert.equal((await prisma.question.findUniqueOrThrow({ where: { id: q.id } })).difficulty, "MEDIUM");
    });

    await check("revision conflict: an edit after the preview makes Apply refuse (nothing changed)", async () => {
      const edited = await applyChange({ postId: post.id, expectedRevision: post.revision, content: { ...post.content, memoryTrick: "MRI = Marrow (edited by admin)" }, note: "test: manual edit", actorId: actor.id });
      await assert.rejects(applyRepair({ postId: post.id, expectedRevision: post.revision, planHash: preview.planHash, codes: "all", actorId: actor.id }), /changed in another window/);
      await assert.rejects(applyRepair({ postId: post.id, expectedRevision: edited.revision, planHash: preview.planHash, codes: "all", actorId: actor.id }), /changed since the preview/);
      assert.equal((await getPostDto(post.id)).content.memoryTrick, "MRI = Marrow (edited by admin)", "the admin's edit is kept");
      post = edited;
      preview = await previewRepair(post.id, "all");
    });

    await check("Master Fix apply: characters and hook fixed (post data only); slides re-rendered 1080×1350; manual edit kept; question text untouched", async () => {
      const r = await applyRepair({ postId: post.id, expectedRevision: post.revision, planHash: preview.planHash, codes: "all", actorId: actor.id });
      post = r.post;
      assert.equal(post.revision, preview.baseRevision + 1);
      assert.ok(!post.issues.some((i) => i.code.startsWith("GLYPHS") || i.code === "SLIDE_MISSING:0"));
      assert.ok(post.issues.some((i) => i.code === "QB_DIFFICULTY_LEGACY"), "the Question Bank warning is left as it is");
      assert.ok(!r.changes.some((c) => /Question Bank/.test(c.target)), "no change targets the Question Bank");
      assert.deepEqual(post.content.quickRevision, ["MRI detects marrow edema before X-ray changes.", "Ca2+ + test"]);
      assert.equal(post.content.memoryTrick, "MRI = Marrow (edited by admin)");
      assert.ok(r.rendered.length > 0 && r.rendered.every((x) => x.width === 1080 && x.height === 1350));
      // Only configuration errors outside the post may remain (the fixture has no Follow-slide handle / Telegram URL).
      assert.deepEqual(post.issues.filter((i) => i.severity === "error").map((i) => i.code).filter((c) => !c.startsWith("FOLLOW_")), []);
      const qq = await prisma.question.findUniqueOrThrow({ where: { id: q.id }, include: { options: true } });
      assert.equal(qq.difficulty, "MEDIUM", "Question Bank difficulty untouched");
      assert.equal(qq.reviewRequired, true);
      assert.equal(qq.reviewReason, 'Difficulty "E" not recognized, will default to MEDIUM');
      assert.equal(qq.text, "What is the imaging of choice for suspected acute osteomyelitis?");
      assert.equal(qq.options.find((o) => o.isCorrect)?.label, "D");
      assert.equal(post.snapshot.reviewRequired, true, "snapshot not rewritten");
      assert.equal(hashSource({ text: post.snapshot.text, options: post.snapshot.options, paperId: post.snapshot.paperId, examName: post.snapshot.examName, paperYear: post.snapshot.paperYear, paperTitle: post.snapshot.paperTitle }), hashBefore);
      assert.ok(!post.issues.some((i) => i.code === "SOURCE_CHANGED"));
      assert.equal(await prisma.auditLog.count({ where: { entityType: "Question", entityId: q.id } }), 0, "no Question audit entry = no Question write");
      assert.equal(await prisma.auditLog.count({ where: { entityId: post.id, action: "INSTAGRAM_FIX_APPLIED" } }), 1);
      // Medical-review warnings are NOT resolved by Master Fix.
      assert.ok(post.issues.some((i) => i.code === "AI_CONTENT") && post.issues.some((i) => i.code === "AI_FLAG:0"));
      // Undo restores the pre-fix content.
      const rev = await prisma.instagramPostRevision.findFirstOrThrow({ where: { postId: post.id, revision: post.revision } });
      assert.equal(rev.baseRevision, post.revision - 1);
    });

    await check("Fix This Error on a single issue; nothing left → refuses", async () => {
      const p2 = await previewRepair(post.id, "all");
      assert.equal(p2.changes.length, 0);
      await assert.rejects(applyRepair({ postId: post.id, expectedRevision: post.revision, planHash: p2.planHash, codes: "all", actorId: actor.id }), /Nothing to fix/);
    });

    await check("medical review: attestation required; AI note decision + full review clear only the medical warnings; an edit brings them back", async () => {
      await assert.rejects(recordMedicalReview({ postId: post.id, expectedRevision: post.revision, actorId: actor.id, fullReview: true, attested: false, note: "", flags: [] }), /Confirm that you checked/);
      await assert.rejects(recordMedicalReview({ postId: post.id, expectedRevision: post.revision, actorId: actor.id, fullReview: false, attested: true, note: "", flags: [{ flag: post.content.aiFlags[0], decision: "context", note: "" }] }), /Explain the exam context/);
      post = await recordMedicalReview({ postId: post.id, expectedRevision: post.revision, actorId: actor.id, fullReview: false, attested: true, note: "", flags: [{ flag: post.content.aiFlags[0], decision: "context", note: "MRI is the investigation of choice; radiographs are the initial test." }] });
      assert.ok(!post.issues.some((i) => i.code.startsWith("AI_FLAG")));
      assert.ok(post.issues.some((i) => i.code === "AI_CONTENT"), "notes-only review does not claim the content was reviewed");
      post = await recordMedicalReview({ postId: post.id, expectedRevision: post.revision, actorId: actor.id, fullReview: true, attested: true, note: "Checked against standard radiology texts.", flags: [] });
      assert.ok(!post.issues.some((i) => i.code === "AI_CONTENT" || i.code.startsWith("AI_FLAG")));
      assert.equal(post.content.medicalReview?.reviewerName, actor.name);
      assert.equal(post.content.medicalReview?.flags.length, 1, "the earlier note decision is kept");
      post = await applyChange({ postId: post.id, expectedRevision: post.revision, content: { ...post.content, explanation: `${post.content.explanation} Bone scan if MRI unavailable.` }, note: "test: edit after review", actorId: actor.id });
      assert.ok(post.issues.some((i) => i.code === "AI_CONTENT") && post.issues.some((i) => i.code === "AI_FLAG:0"));
    });

    await check("AI suggestion: only the chosen section, old/new diff, signed; Accept writes one revision; answer key + provenance unchanged", async () => {
      const stub = async () => ({ text: JSON.stringify({ answerLabel: "D", quickRevision: ["MRI: marrow edema within days", "Radiographs: normal for 10–14 days"], explanation: "SHOULD NOT APPEAR", confidence: "medium", concerns: ["Check the timing"] }), provider: "stub", model: "stub-1" } as never);
      const base = normalizeContent((await prisma.instagramPost.findUniqueOrThrow({ where: { id: post.id } })).content);
      const out = await generateContent({ snapshot: post.snapshot, series: "PYQ", stats: null, current: base, targets: ["quickRevision"], reference: null, allowedDomains: ["mocktestseries.in"], generator: stub });
      const prop = makeProposal({ postId: post.id, actorId: actor.id, baseRevision: post.revision, label: "Quick Revision", before: base, after: out.content, summary: out.summary, allowed: allowedKeysFor("content", ["quickRevision"]) });
      assert.deepEqual(prop.diff.map((d) => d.key), ["quickRevision"]);
      assert.ok(prop.flags.some((f) => /confidence is medium/.test(f)));
      assert.equal((await getPostDto(post.id)).revision, post.revision, "a suggestion writes nothing");
      // Tampering is refused.
      const [body, mac] = prop.token.split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), patch: { explanation: "forged" } })).toString("base64url");
      await assert.rejects(acceptProposal({ postId: post.id, expectedRevision: post.revision, token: `${forged}.${mac}`, actorId: actor.id }), /Invalid AI suggestion/);
      await assert.rejects(acceptProposal({ postId: post.id, expectedRevision: post.revision, token: prop.token, actorId: "someone-else" }), /Invalid AI suggestion/);
      const accepted = await acceptProposal({ postId: post.id, expectedRevision: post.revision, token: prop.token, actorId: actor.id });
      assert.equal(accepted.revision, post.revision + 1);
      assert.deepEqual(accepted.content.quickRevision, ["MRI: marrow edema within days", "Radiographs: normal for 10–14 days"]);
      assert.equal(accepted.content.explanation, post.content.explanation, "other sections untouched");
      assert.equal(accepted.snapshot.options.find((o) => o.isCorrect)?.label, "D");
      assert.equal(accepted.questionNumber, null, "no printed number invented");
      assert.ok(accepted.issues.some((i) => i.code === "AI_CONTENT"), "accepted AI text needs medical review");
      // Accepting twice (stale revision) is refused.
      await assert.rejects(acceptProposal({ postId: post.id, expectedRevision: accepted.revision, token: prop.token, actorId: actor.id }), /changed after this suggestion/);
      post = accepted;
    });

    await check("AI suggestion that contradicts the answer key is discarded before any suggestion exists", async () => {
      const bad = async () => ({ text: JSON.stringify({ answerLabel: "B", explanation: "X-ray is the answer.", confidence: "high" }), provider: "stub", model: "stub-1" } as never);
      await assert.rejects(generateContent({ snapshot: post.snapshot, series: "PYQ", stats: null, current: post.content, targets: ["explanation"], reference: null, allowedDomains: [], generator: bad }), /disagreed with the stored answer key/);
    });

    await check("Question Bank fingerprint identical after every studio action (fix, AI suggestion, review, edits)", async () => {
      assert.equal(await qbFingerprint(), qbBefore);
    });

    await check("duplicate draft prevention: a second create opens the existing draft", async () => {
      const again = await createDraft({ questionId: q.id, series: "PYQ", stats: null, actorId: actor.id });
      assert.equal(again.existed, true);
      assert.equal(again.post.id, post.id);
    });
  } finally {
    await cleanupQs();
  }
}

async function main() {
  await partA();
  await partB();
  console.log(`\n${passed} checks passed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
