/**
 * Instagram TOPIC posts (Phase 2) — regression for topic carousels AND for the
 * question posts they must not change.
 *
 * Part A is pure (plus the renderer, network blocked). Part B runs on an
 * *igstudio* scratch database with the topic migration applied:
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-topic-posts.ts
 * Part B creates topic posts on the fixture exams and removes them afterwards.
 * No AI provider, no Meta call: every outbound fetch fails the suite.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { buildPrompt, parseAiResponse, TOPIC_ECHO } from "@/lib/instagram/ai-core";
import { checklistFor, runQualityGate, type QualityInput } from "@/lib/instagram/quality";
import { unsupportedChars } from "@/lib/instagram/glyphs";
import { renderSlideJpeg, seriesTag } from "@/lib/instagram/render";
import { slideSequence } from "@/lib/instagram/layout";
import { checkDesignInput } from "@/lib/instagram/validate";
import { SAMPLE_INPUT, SAMPLE_SETTINGS } from "@/lib/instagram/sample";
import {
  DEFAULT_LAYOUTS,
  TOPIC_DEFAULT_MODULES,
  defaultDesign,
  emptyContent,
  normalizeDesign,
  topicLayout,
  validateModules,
  type PostContent,
  type SourceSnapshot,
} from "@/lib/instagram/types";

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

const topicSnap: SourceSnapshot = {
  ...SAMPLE_INPUT.snapshot,
  kind: "topic",
  notes: "Renal artery stenosis, primary hyperaldosteronism, pheochromocytoma, Cushing syndrome, coarctation of aorta.",
  questionId: "",
  code: "TOPIC",
  text: "Causes of secondary hypertension",
  contentFormat: "PLAIN",
  questionType: "TOPIC",
  options: [],
  paperId: null,
  paperTitle: null,
  paperYear: null,
  paperCode: null,
  paperSharesYear: false,
  importPosition: null,
  subjectName: "Medicine",
  topicName: "Causes of secondary hypertension",
  aiExplanation: null,
};
const topicContent = (): PostContent => ({
  ...emptyContent(),
  hookText: "Secondary Hypertension: 5 Causes to Know",
  explanation: "Suspect a secondary cause in young patients, resistant hypertension or sudden onset.",
  memoryTrick: "Think kidneys, adrenals, aorta.",
  clinicalPearl: "Hypokalaemia with hypertension suggests primary hyperaldosteronism.",
  quickRevision: ["Renal artery stenosis: abdominal bruit", "Coarctation: radio-femoral delay"],
  pearls: ["Pheochromocytoma: episodic headache, sweating, palpitations", "Cushing syndrome: central obesity, striae"],
  mistakes: ["Missing hypokalaemia as a clue", "Forgetting coarctation in young adults"],
  caption: "Five causes of secondary hypertension.\nSave this post and comment one more cause you remember.",
  hashtags: ["#Medicine", "#Hypertension"],
});
const topicDesign = () => ({ ...defaultDesign(), modules: [...TOPIC_DEFAULT_MODULES], slideCount: TOPIC_DEFAULT_MODULES.length });
const gate = (over: Partial<QualityInput> = {}): QualityInput => ({
  snapshot: topicSnap,
  content: topicContent(),
  design: topicDesign(),
  series: "TOPIC",
  seriesStats: null,
  questionNumber: null,
  questionNumberVerified: false,
  currentHash: "h",
  snapshotHash: "h",
  follow: { instagramHandle: "mocktestseries.in", showInstagram: true, telegramUrl: "https://t.me/x", showTelegram: true },
  allowedDomains: ["mocktestseries.in", "t.me", "instagram.com"],
  unsupportedChars,
  settingsTexts: [],
  ...over,
});
const codes = (i: QualityInput) => runQualityGate(i).map((x) => `${x.severity}:${x.code}`);

async function partA() {
  console.log("Part A — topic layouts, quality gate, prompts, rendering (pure)");

  await check("layouts: question rules unchanged; topic rules forbid Question/Answer/Trap and need the Hook first", () => {
    for (const n of [3, 4, 5, 6, 7] as const) assert.equal(validateModules(DEFAULT_LAYOUTS[n]), null, `question preset ${n}`);
    assert.match(validateModules(TOPIC_DEFAULT_MODULES) ?? "", /Question and Answer slides are required/, "default kind stays question");
    assert.equal(validateModules(TOPIC_DEFAULT_MODULES, "topic"), null);
    for (const n of [3, 4, 5, 6, 7, 8]) assert.equal(validateModules(topicLayout(n), "topic"), null, `topic preset ${n}`);
    assert.equal(topicLayout(5).length, 5);
    assert.match(validateModules(["HOOK", "QUESTION", "ANSWER", "FOLLOW"], "topic") ?? "", /can't use Question, Answer/);
    assert.match(validateModules(["HOOK", "PEARLS", "TRAP", "FOLLOW"], "topic") ?? "", /Examiner/);
    assert.match(validateModules(["PEARLS", "HOOK", "MISTAKES", "FOLLOW"], "topic") ?? "", /starts with the Hook/);
    assert.ok(validateModules(["HOOK", "PEARLS", "FOLLOW", "MISTAKES"], "topic"), "Follow still last");
    assert.equal(validateModules(TOPIC_DEFAULT_MODULES, "any"), null);
    assert.equal(validateModules(DEFAULT_LAYOUTS[5], "any"), null);
  });

  await check("stored designs: normalizeDesign keeps a topic layout and a question layout as they are", () => {
    assert.deepEqual(normalizeDesign(topicDesign()).modules, TOPIC_DEFAULT_MODULES);
    assert.deepEqual(normalizeDesign(defaultDesign(undefined, 6)).modules, DEFAULT_LAYOUTS[6]);
    assert.deepEqual(normalizeDesign({ modules: ["PEARLS", "FOLLOW"] }).modules, DEFAULT_LAYOUTS[5], "invalid still falls back");
  });

  await check("saving: checkDesignInput applies the post's series (topic layout refused on a question post and vice versa)", () => {
    assert.equal(checkDesignInput(topicDesign(), "TOPIC").ok, true);
    assert.equal(checkDesignInput(topicDesign(), "PYQ").ok, false);
    assert.equal(checkDesignInput(topicDesign()).ok, false, "no series = question rules (unchanged callers)");
    assert.equal(checkDesignInput(defaultDesign(), "PYQ").ok, true);
    assert.equal(checkDesignInput(defaultDesign(), "TOPIC").ok, false);
  });

  await check("quality gate: a complete topic post has no errors and no question checks", () => {
    const c = codes(gate());
    assert.deepEqual(c.filter((x) => x.startsWith("error")), []);
    for (const q of ["STEM_EMPTY", "OPTIONS_FEW", "ANSWER_KEY", "NOT_PYQ", "QUESTION_NUMBER_MISSING"]) assert.ok(!c.some((x) => x.endsWith(`:${q}`)), q);
  });

  await check("quality gate: topic-specific errors and warnings", () => {
    assert.ok(codes(gate({ design: { ...topicDesign(), modules: ["HOOK", "QUESTION", "ANSWER", "FOLLOW"], slideCount: 4 } })).includes("error:TOPIC_MODULES"));
    assert.ok(codes(gate({ snapshot: { ...topicSnap, text: "  " } })).includes("error:TOPIC_EMPTY"));
    assert.ok(codes(gate({ snapshot: { ...topicSnap, text: "x".repeat(95) } })).includes("error:TOPIC_LONG"));
    assert.ok(codes(gate({ content: { ...topicContent(), hookText: "" } })).includes("error:TOPIC_NO_COVER"));
    assert.ok(codes(gate({ snapshot: { ...topicSnap, notes: "" } })).includes("warning:TOPIC_NO_SOURCE"));
    assert.ok(!codes(gate()).includes("warning:TOPIC_NO_SOURCE"));
    assert.ok(codes(gate({ series: "PYQ" })).includes("error:SOURCE_KIND"), "series/source mismatch");
    assert.ok(codes(gate({ snapshot: { ...topicSnap, examName: "NEET UG" } })).includes("error:EXAM_OUT_OF_SCOPE"));
    assert.ok(codes(gate({ content: { ...topicContent(), caption: "" } })).includes("error:CAPTION_EMPTY"));
  });

  await check("quality gate: question posts give exactly the same issues as before (no SOURCE_KIND, no topic codes)", () => {
    const q: QualityInput = { ...gate(), snapshot: SAMPLE_INPUT.snapshot, content: { ...SAMPLE_INPUT.content, caption: "Can you solve this?\nComment your answer.", hashtags: ["#RUHSMO"] }, design: defaultDesign(), series: "PYQ", questionNumber: 12, questionNumberVerified: true };
    const c = codes(q);
    assert.ok(!c.some((x) => /SOURCE_KIND|TOPIC_/.test(x)), c.join(","));
    assert.ok(!codes({ ...q, snapshot: { ...SAMPLE_INPUT.snapshot, options: [] } }).every((x) => !x.endsWith(":OPTIONS_FEW")), "question checks still run");
  });

  await check("review checklist: topic posts skip the paper / answer-key / attribution items", () => {
    const keys = checklistFor(topicDesign(), "TOPIC").map((c) => c.key);
    assert.deepEqual(keys, ["medicalReviewed", "extrasReviewed"]);
    assert.equal(checklistFor(defaultDesign(undefined, 7), "PYQ").length, 5);
    assert.equal(checklistFor(defaultDesign(undefined, 7)).length, 5, "callers without a series unchanged");
  });

  await check("AI prompt: topic prompt teaches the topic (no options, no key) and asks for the TOPIC echo", () => {
    const p = buildPrompt({ snapshot: topicSnap, series: "TOPIC", stats: null, targets: ["hooks", "explanation", "pearls", "mistakes", "caption"], current: emptyContent() });
    assert.match(p, /Topic: Causes of secondary hypertension/);
    assert.match(p, /Source notes from the admin/);
    assert.match(p, new RegExp(`"answerLabel": exactly "${TOPIC_ECHO}"`));
    assert.doesNotMatch(p, /Correct answer|official key|Previous Year Paper/);
    assert.doesNotMatch(p, /\n\n\n/);
    const q = buildPrompt({ snapshot: SAMPLE_INPUT.snapshot, series: "PYQ", stats: null, targets: ["explanation"], current: emptyContent() });
    assert.match(q, /Correct answer \(from the official key\)/, "question prompt unchanged");
    assert.doesNotMatch(q, /TOPIC/);
  });

  await check("AI response: topic needs the TOPIC echo; a question still needs the stored key", () => {
    const body = (label: string) => JSON.stringify({ answerLabel: label, explanation: "Young patients with resistant hypertension need a work-up for secondary causes.", confidence: "high", concerns: [] });
    const ok = parseAiResponse(body("TOPIC"), topicSnap, ["explanation"], ["mocktestseries.in"]);
    assert.equal(ok.fatal, undefined);
    assert.ok(ok.patch.explanation);
    assert.match(parseAiResponse(body("B"), topicSnap, ["explanation"], []).fatal ?? "", /topic instructions/);
    const correct = SAMPLE_INPUT.snapshot.options.filter((o) => o.isCorrect).map((o) => o.label).join(",");
    assert.equal(parseAiResponse(body(correct), SAMPLE_INPUT.snapshot, ["explanation"], []).fatal, undefined);
    assert.match(parseAiResponse(body("TOPIC"), SAMPLE_INPUT.snapshot, ["explanation"], []).fatal ?? "", /did not confirm|disagreed/);
  });

  await check("render: every topic slide renders 1080×1350 with the HIGH-YIELD TOPIC tag, offline", async () => {
    const input = { ...SAMPLE_INPUT, snapshot: topicSnap, content: topicContent(), design: topicDesign(), series: "TOPIC" as const, seriesStats: null, questionNumber: null, settings: SAMPLE_SETTINGS };
    assert.equal(seriesTag(input), "HIGH-YIELD TOPIC");
    const n = slideSequence(input.content, input.design).length;
    assert.equal(n, TOPIC_DEFAULT_MODULES.length);
    for (let i = 0; i < n; i++) {
      const meta = await sharp(await renderSlideJpeg(input, i)).metadata();
      assert.equal(meta.width, 1080);
      assert.equal(meta.height, 1350);
    }
    assert.deepEqual(fetches, []);
  });
}

async function partB() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.includes("igstudio")) {
    console.log("Part B — skipped (needs a scratch DB whose name contains 'igstudio')");
    return;
  }
  console.log(`Part B — topic lifecycle on scratch DB ${dbName}`);
  const posts = await import("@/lib/instagram/posts");
  const { checkPublishable } = await import("@/lib/instagram/publish");
  const { listTopicPosts, listDrafts } = await import("@/lib/instagram/queries");
  const { saveStudioSettings } = await import("@/lib/instagram/config");
  const { topicKeyFor } = await import("@/lib/instagram/topic");

  const exams = await prisma.exam.findMany({ where: { code: { in: ["IGFIX-RUHS", "IGFIX-RPSC"] } } });
  assert.equal(exams.length, 2, "run scripts/ig-studio-fixture.ts setup first");
  const ruhs = exams.find((e) => e.code === "IGFIX-RUHS")!;
  const actorId = (await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } })).id;
  await saveStudioSettings({ instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries_fixture" });
  const cleanupTopics = () => prisma.instagramPost.deleteMany({ where: { series: "TOPIC", topicKey: { startsWith: `${ruhs.id}:` } } });
  await cleanupTopics();

  // The question posts that exist before this suite (left by earlier suites) must be untouched by it.
  const questionRows = async () =>
    JSON.stringify(await prisma.instagramPost.findMany({ where: { series: { not: "TOPIC" } }, orderBy: { id: "asc" }, select: { id: true, questionId: true, version: true, status: true, revision: true, sourceHash: true, supersededAt: true, updatedAt: true } }));
  const before = await questionRows();

  await check("migration: CHECK constraint refuses a topic row with a question and a question row without one", async () => {
    const base = { questionCode: "X", version: 1, content: {}, design: {}, sourceSnapshot: {}, sourceHash: "h", createdById: actorId };
    await assert.rejects(prisma.instagramPost.create({ data: { ...base, series: "TOPIC", questionId: "q1", topicKey: "k" } }), /InstagramPost_source_check|violates check/);
    await assert.rejects(prisma.instagramPost.create({ data: { ...base, series: "TOPIC", questionId: null, topicKey: null } }), /InstagramPost_source_check|violates check/);
    await assert.rejects(prisma.instagramPost.create({ data: { ...base, series: "PYQ", questionId: null, topicKey: null } }), /InstagramPost_source_check|violates check/);
    await assert.rejects(prisma.instagramPost.create({ data: { ...base, series: "PYQ", questionId: "q1", topicKey: "k" } }), /InstagramPost_source_check|violates check/);
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'InstagramPost' ORDER BY 1`;
    const names = idx.map((r) => r.indexname);
    for (const n of ["InstagramPost_one_current_per_question", "InstagramPost_one_publishing_per_question", "InstagramPost_questionId_version_key", "InstagramPost_one_current_per_topic", "InstagramPost_one_publishing_per_topic", "InstagramPost_topicKey_version_key"]) {
      assert.ok(names.includes(n), n);
    }
  });

  let postId = "";
  const title = "Causes of secondary hypertension";
  await check("create: topic draft with the topic layout, frozen topic snapshot, revision 1, audit row", async () => {
    await assert.rejects(posts.createTopicDraft({ title: "ab", examId: ruhs.id, actorId }), /at least 3/);
    await assert.rejects(posts.createTopicDraft({ title: "x".repeat(91), examId: ruhs.id, actorId }), /too long/);
    const r = await posts.createTopicDraft({ title: `  ${title}  `, examId: ruhs.id, subjectName: "Medicine", notes: topicSnap.notes, actorId });
    assert.equal(r.existed, false);
    postId = r.post.id;
    assert.equal(r.post.series, "TOPIC");
    assert.equal(r.post.questionId, null);
    assert.equal(r.post.topicKey, topicKeyFor(ruhs.id, title));
    assert.equal(r.post.snapshot.kind, "topic");
    assert.equal(r.post.snapshot.text, title);
    assert.equal(r.post.snapshot.examName, ruhs.name);
    assert.deepEqual(r.post.design.modules, TOPIC_DEFAULT_MODULES);
    assert.equal(r.post.content.hookText, title);
    assert.equal(r.post.sourceChanged, false);
    assert.equal(r.post.sourceDeleted, false);
    assert.ok(!r.post.issues.some((i) => /STEM|OPTION|ANSWER_KEY|NOT_PYQ|SOURCE_/.test(i.code)), r.post.issues.map((i) => i.code).join(","));
    assert.equal(await prisma.auditLog.count({ where: { entityId: postId, action: "INSTAGRAM_TOPIC_DRAFT_CREATED" } }), 1);
  });

  await check("duplicates: same topic (case/spacing/punctuation) opens the existing post; 6 parallel creates → 1 row", async () => {
    const again = await posts.createTopicDraft({ title: "causes of SECONDARY hypertension!", examId: ruhs.id, actorId });
    assert.equal(again.existed, true);
    assert.equal(again.post.id, postId);
    const many = await Promise.all(Array.from({ length: 6 }, () => posts.createTopicDraft({ title: "Drugs causing gynaecomastia", examId: ruhs.id, actorId })));
    assert.equal(new Set(many.map((m) => m.post.id)).size, 1);
    assert.equal(many.filter((m) => !m.existed).length, 1);
    assert.equal(await prisma.instagramPost.count({ where: { topicKey: topicKeyFor(ruhs.id, "Drugs causing gynaecomastia") } }), 1);
  });

  await check("edit: save, conflict guard, undo, restore — same revision history as question posts", async () => {
    const p0 = await posts.getPostDto(postId);
    const saved = await posts.applyChange({ postId, expectedRevision: p0.revision, content: topicContent(), note: "manual", actorId });
    assert.equal(saved.revision, p0.revision + 1);
    await assert.rejects(posts.applyChange({ postId, expectedRevision: p0.revision, note: "stale", actorId }), /another window/);
    const undone = await posts.undoLast(postId, saved.revision, actorId);
    assert.equal(undone.content.explanation, "");
    const restored = await posts.restoreRevision(postId, undone.revision, saved.revision, actorId);
    assert.equal(restored.content.explanation, topicContent().explanation);
    assert.deepEqual(restored.design.modules, TOPIC_DEFAULT_MODULES, "layout survives every round trip");
    await assert.rejects(posts.refreshSnapshot(postId, restored.revision, actorId), /no Question Bank source/);
  });

  await check("publish preflight: a complete topic post passes every server-side check (no Meta call)", async () => {
    const row = await prisma.instagramPost.findUniqueOrThrow({ where: { id: postId } });
    const pre = await checkPublishable(row, row.revision, "CAROUSEL");
    assert.equal(pre.slideCount, TOPIC_DEFAULT_MODULES.length);
    assert.deepEqual(pre.checklist.map((c) => c.key), ["medicalReviewed", "extrasReviewed"]);
    const bad = await posts.applyChange({ postId, expectedRevision: row.revision, design: { ...topicDesign(), modules: ["HOOK", "QUESTION", "ANSWER", "FOLLOW"], slideCount: 4 }, note: "bad layout", actorId });
    const row2 = await prisma.instagramPost.findUniqueOrThrow({ where: { id: postId } });
    await assert.rejects(checkPublishable(row2, bad.revision, "CAROUSEL"), /can't use Question, Answer/);
    await posts.undoLast(postId, bad.revision, actorId);
    assert.deepEqual(fetches, []);
  });

  await check("versions: a published topic gets v2 (v1 kept); deleting v2 makes v1 current again", async () => {
    await prisma.instagramPost.update({ where: { id: postId }, data: { status: "PUBLISHED", igMediaId: "fixture-media", publishedAt: new Date() } });
    const v2 = await posts.createNewVersion(postId, actorId);
    assert.equal(v2.version, 2);
    assert.equal(v2.series, "TOPIC");
    assert.equal(v2.topicKey, topicKeyFor(ruhs.id, title));
    assert.deepEqual(v2.design.modules, TOPIC_DEFAULT_MODULES);
    const state = await posts.getTopicPostState(v2.topicKey!);
    assert.equal(state.current?.id, v2.id);
    assert.deepEqual(state.history.map((h) => h.version), [2, 1]);
    assert.equal(state.posted, true);
    await assert.rejects(posts.createNewVersion(postId, actorId), /newer version/);
    const again = await posts.createTopicDraft({ title, examId: ruhs.id, actorId });
    assert.equal(again.post.id, v2.id, "create opens the current version");
    await posts.deleteDraft(v2.id, actorId);
    const after = await posts.getTopicPostState(v2.topicKey!);
    assert.equal(after.current?.id, postId);
  });

  await check("lists: Topic Posts lists topics only; Drafts shows topic drafts beside question drafts", async () => {
    const topics = await listTopicPosts();
    assert.ok(topics.length >= 2 && topics.every((t) => t.series === "TOPIC" && t.questionId === null && t.topicKey));
    const drafts = await listDrafts();
    assert.ok(drafts.some((d) => d.series === "TOPIC"));
    assert.ok(drafts.filter((d) => d.series !== "TOPIC").every((d) => d.questionId && d.topicKey === null));
  });

  await check("question posts: still created, deduplicated and unaffected by the topic rows", async () => {
    // A PYQ fixture question with no post yet, so the pre-existing question posts stay exactly as they were.
    const used = new Set((await prisma.instagramPost.findMany({ where: { questionId: { not: null } }, select: { questionId: true } })).map((x) => x.questionId));
    const candidates = await prisma.question.findMany({ where: { examId: ruhs.id, previousYearPaperId: { not: null }, code: { in: ["IGFIX-RUHS21-W01", "IGFIX-RUHS21-W02", "IGFIX-RUHS21-W05", "IGFIX-RUHS21-W06", "IGFIX-RUHS21-W07"] } }, orderBy: { code: "asc" } });
    const good = candidates.find((c) => !used.has(c.id));
    assert.ok(good, "a fixture question without a post");
    const r = await posts.createDraft({ questionId: good.id, series: "PYQ", stats: null, actorId });
    assert.equal(r.post.series, "PYQ");
    assert.equal(r.post.topicKey, null);
    assert.equal(validateModules(r.post.design.modules), null, "question layout");
    const twice = await posts.createDraft({ questionId: good.id, series: "PYQ", stats: null, actorId });
    assert.equal(twice.post.id, r.post.id);
    await prisma.instagramPost.deleteMany({ where: { questionId: good.id } });
  });

  await cleanupTopics();
  await check("cleanup: topic rows removed; pre-existing question posts byte-identical", async () => {
    assert.equal(await prisma.instagramPost.count({ where: { series: "TOPIC", topicKey: { startsWith: `${ruhs.id}:` } } }), 0);
    assert.equal(await questionRows(), before);
  });
}

(async () => {
  await partA();
  await partB();
  console.log(`\n${passed} passed, 0 failed`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  console.log(`\n${passed} passed, 1 failed`);
  await prisma.$disconnect();
  process.exit(1);
});
