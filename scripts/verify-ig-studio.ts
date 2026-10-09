/**
 * Instagram Content Studio — library regression.
 *
 *   set -a; . ./.env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-studio.ts
 *
 * Part A is pure. Part B writes InstagramPost rows (and, for one source-change
 * check, temporarily edits one FIXTURE question and restores it), so it only
 * runs on a database whose name contains "igstudio". The renderer is run with
 * the network blocked: any outbound fetch fails the suite.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { checkText } from "@/lib/instagram/content-safety";
import { buildPrompt, parseAiResponse } from "@/lib/instagram/ai-core";
import { generateContent, prefillFromReference } from "@/lib/instagram/ai";
import { parseLayoutInstruction, targetFields } from "@/lib/instagram/instructions";
import { estimateLines, planSlides } from "@/lib/instagram/layout";
import { runQualityGate, stemLooksTruncated, REVIEW_CHECKLIST, type QualityInput } from "@/lib/instagram/quality";
import { renderable, unsupportedChars } from "@/lib/instagram/glyphs";
import { checkContentInput, checkDesignInput } from "@/lib/instagram/validate";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { SAMPLE_INPUT, SAMPLE_SETTINGS } from "@/lib/instagram/sample";
import {
  DEFAULT_LAYOUTS,
  composeCaption,
  defaultDesign,
  emptyContent,
  normalizeContent,
  normalizeDesign,
  normalizeHashtags,
  validateModules,
  type PostContent,
} from "@/lib/instagram/types";
import { getAiReference } from "@/lib/instagram/snapshot";

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

const snap = SAMPLE_INPUT.snapshot;
const ctx = { paperYear: 2021, correctLabels: ["B"], optionLabels: ["A", "B", "C", "D"] };
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
const codes = (input: QualityInput) => runQualityGate(input).map((i) => `${i.severity}:${i.code}`);

async function partA() {
  console.log("Part A — pure rules");

  await check("slide order rules: 3–6 slides, Follow last, Answer after Question, no duplicate content slides", () => {
    for (const n of [3, 4, 5, 6] as const) assert.equal(validateModules(DEFAULT_LAYOUTS[n]), null);
    assert.ok(validateModules(["QUESTION", "FOLLOW"]));
    assert.ok(validateModules(["QUESTION", "ANSWER", "FOLLOW", "HOOK"]));
    assert.ok(validateModules(["ANSWER", "QUESTION", "FOLLOW"]));
    assert.ok(validateModules(["QUESTION", "ANSWER", "EXPLANATION", "EXPLANATION_TRICK", "FOLLOW"]));
    assert.ok(validateModules(["QUESTION", "QUESTION", "ANSWER", "FOLLOW"]));
    assert.deepEqual(normalizeDesign({ modules: ["FOLLOW"], template: "evil", questionScale: 9 }).modules, DEFAULT_LAYOUTS[5]);
    assert.equal(normalizeDesign({ questionScale: 9 }).questionScale, 1.25);
    assert.equal(normalizeDesign({ template: "evil" }).template, "midnight");
  });

  await check("hashtags normalized: '#', allowed chars, de-duplicated, max 15", () => {
    assert.deepEqual(normalizeHashtags(["neet pg", "#NEET", "##neet", "#a", "RUHS-MO", "#ok_1"]), ["#neet", "#pg", "#RUHSMO", "#ok_1"]);
    assert.equal(normalizeHashtags(Array.from({ length: 30 }, (_, i) => `tag${i}`)).length, 15);
    assert.equal(composeCaption({ caption: " Hi ", hashtags: ["#a1", "#b2"] }), "Hi\n\n#a1 #b2");
  });

  await check("content safety: invented repetition / statistics / references / Hindi / wrong answer / other years / unknown links", () => {
    const rules = (t: string, o = {}) => checkText(t, ctx, o).map((p) => p.rule);
    assert.deepEqual(rules("This is a frequently asked question"), ["UNSUPPORTED_FREQUENCY_CLAIM"]);
    assert.deepEqual(rules("Most repeated PYQ topic"), ["UNSUPPORTED_FREQUENCY_CLAIM"]);
    assert.deepEqual(rules("Asked every year in RUHS"), ["UNSUPPORTED_FREQUENCY_CLAIM"]);
    assert.deepEqual(rules("Sure-shot question!"), ["UNSUPPORTED_FREQUENCY_CLAIM"]);
    assert.deepEqual(rules("80% of students get this wrong"), ["UNSUPPORTED_STATISTIC"]);
    assert.deepEqual(rules("See Harrison 21st edition page 233"), ["UNVERIFIED_REFERENCE"]);
    assert.deepEqual(rules("यह सही उत्तर है"), ["UNSUPPORTED_SCRIPT"]);
    assert.deepEqual(rules("The correct answer is C"), ["ANSWER_CONTRADICTION"]);
    assert.deepEqual(rules("Answer: B"), []);
    assert.deepEqual(rules("RUHS 2019 asked this", { strictYears: true }), ["UNVERIFIED_YEAR"]);
    assert.deepEqual(rules("RUHS 2021 PYQ", { strictYears: true }), []);
    assert.deepEqual(rules("Per the 2019 guideline", {}), []);
    assert.deepEqual(rules("Visit https://evil.example/x", { allowedDomains: ["mocktestseries.in"] }), ["UNKNOWN_LINK"]);
    assert.deepEqual(rules("Practice at https://mocktestseries.in/pyq", { allowedDomains: ["mocktestseries.in"] }), []);
  });

  await check("damaged stems are flagged, never repaired", () => {
    assert.equal(stemLooksTruncated("ll are types of RCT except:"), true);
    assert.equal(stemLooksTruncated("ost Theuterotonic drug is"), true);
    assert.equal(stemLooksTruncated("- the drug"), true);
    assert.equal(stemLooksTruncated("pH of blood is"), false);
    assert.equal(stemLooksTruncated("mRNA vaccines are"), false);
    assert.equal(stemLooksTruncated("All are true except"), false);
    assert.equal(stemLooksTruncated("“Quoted” stem"), false);
    assert.equal(stemLooksTruncated("β-lactamase inhibitor is"), false);
    assert.equal(stemLooksTruncated("α-blockers cause"), false);
    assert.equal(stemLooksTruncated("? which drug"), true);
  });

  await check("AI response: must echo the stored answer; invalid JSON / disagreement change nothing", () => {
    const ok = JSON.stringify({ answerLabel: "B", explanation: "Ethosuximide blocks T-type calcium channels.", confidence: "high", concerns: [] });
    assert.equal(parseAiResponse(ok, snap, ["explanation"], ["mocktestseries.in"]).patch.explanation, "Ethosuximide blocks T-type calcium channels.");
    assert.match(parseAiResponse("not json", snap, ["explanation"], []).fatal ?? "", /not valid JSON/);
    assert.match(parseAiResponse(JSON.stringify({ explanation: "x" }), snap, ["explanation"], []).fatal ?? "", /did not confirm/);
    assert.match(parseAiResponse(JSON.stringify({ answerLabel: "C", explanation: "x" }), snap, ["explanation"], []).fatal ?? "", /disagreed/);
  });

  await check("AI response: unsafe or over-long fields rejected individually; low confidence becomes a review flag", () => {
    const r = parseAiResponse(
      JSON.stringify({
        answerLabel: "b",
        hooks: [
          { style: "curiosity", text: "Can You Solve This RUHS MO PYQ?" },
          { style: "challenge", text: "Most repeated question of RUHS!" },
          { style: "memory", text: "x".repeat(200) },
        ],
        memoryTrick: "ETHO = Empty THOughts",
        caption: "Asked in 2019 and 2021",
        quickRevision: ["a", "b", "c", "d", "e"],
        hashtags: ["#RUHS", "neet pg"],
        confidence: "medium",
        concerns: ["Check whether valproate is also acceptable"],
      }),
      snap,
      ["hooks", "memoryTrick", "caption", "quickRevision", "hashtags"],
      ["mocktestseries.in"]
    );
    assert.equal(r.fatal, undefined);
    assert.deepEqual(r.patch.hooks, [{ style: "curiosity", text: "Can You Solve This RUHS MO PYQ?" }]);
    assert.equal(r.patch.memoryTrick, "ETHO = Empty THOughts");
    assert.equal(r.patch.caption, undefined);
    assert.equal(r.patch.quickRevision, undefined);
    assert.deepEqual(r.patch.hashtags, ["#RUHS", "#neet", "#pg"]);
    assert.deepEqual(r.rejected.map((x) => x.field).sort(), ["caption", "hooks", "quickRevision"]);
    assert.match(r.flags[0], /confidence is medium: Check whether valproate/);
  });

  await check("prompt: fixed stem/options/answer, exact attribution, Hindi instruction allowed, output English, no student data", () => {
    const p = buildPrompt({ snapshot: snap, series: "PYQ", stats: null, targets: ["hooks", "caption"], current: emptyContent(), instruction: "Hook ko aur attractive banao" });
    assert.ok(p.includes("Correct answer (from the official key): B"));
    assert.ok(p.includes("RUHS MO — Previous Year Paper 2021"));
    assert.ok(p.includes("B. Ethosuximide"));
    assert.ok(p.includes("always WRITE the output in English"));
    assert.ok(p.includes("Never mention any year other than 2021"));
    assert.ok(!/student(Id)?\s*[:=]|@example|IGFIX-S/i.test(p));
    const practice = buildPrompt({ snapshot: { ...snap, paperYear: null, paperId: null }, series: "MOST_MISSED", stats: null, targets: ["hooks"], current: emptyContent() });
    assert.ok(practice.includes("NOT a previous year paper question"));
    assert.ok(practice.includes("do NOT write any percentage"));
  });

  await check("instruction routing (English + Hindi): layout changes need no AI; content edits target named fields", () => {
    const d = defaultDesign();
    assert.deepEqual(parseLayoutInstruction("Increase question font size", d)?.patch, { questionScale: 1.1 });
    assert.deepEqual(parseLayoutInstruction("question ka font size bada karo", d)?.patch, { questionScale: 1.1 });
    assert.deepEqual(parseLayoutInstruction("font size chhota karo", d)?.patch, { questionScale: 0.9, bodyScale: 0.9 });
    assert.equal(parseLayoutInstruction("Change background to light", d)?.patch.template, "academic");
    assert.equal(parseLayoutInstruction("बैकग्राउंड बदलो", d)?.patch.template, "academic");
    assert.equal(parseLayoutInstruction("Make the hook more attractive", d), null);
    assert.deepEqual(targetFields("Make the hook more attractive", null), ["hooks"]);
    assert.deepEqual(targetFields("Explanation ko aur simple banao", null), ["explanation"]);
    assert.deepEqual(targetFields("याद रखने की ट्रिक दो", null), ["memoryTrick"]);
    assert.deepEqual(targetFields("better", "PEARL_REVISION"), ["clinicalPearl", "quickRevision"]);
    assert.equal(targetFields("improve", null).length, 8);
  });

  await check("editor input: caps enforced (rejected, not cut); provenance is server-owned", () => {
    const prev = { ...emptyContent(), origin: { kind: "ai" as const, model: "m" }, aiFlags: ["AI confidence is low"] };
    const tooLong = checkContentInput({ ...prev, explanation: "x".repeat(421) }, prev);
    assert.equal(tooLong.ok, false);
    const forged = checkContentInput({ ...prev, explanation: "  Fine  text ", origin: { kind: "manual" }, aiFlags: [] }, prev);
    assert.ok(forged.ok && forged.value.origin.kind === "ai" && forged.value.aiFlags.length === 1 && forged.value.explanation === "Fine text");
    assert.equal(checkContentInput({ ...prev, quickRevision: ["1", "2", "3", "4", "5"] }, prev).ok, false);
    assert.equal(checkDesignInput({ modules: ["QUESTION", "FOLLOW"] }).ok, false);
    assert.equal(checkDesignInput({ modules: ["QUESTION", "ANSWER", "FOLLOW"] }).ok, true);
  });

  await check("glyph coverage: Latin, Greek and medical symbols drawable; emoji and ⁺ are not (shown as □)", () => {
    assert.deepEqual(unsupportedChars("β-lactam α γ δ µ ± ≥ → ° ² ₂ × — … “quotes” ½"), []);
    assert.deepEqual(unsupportedChars("Ca⁺⁺ 🔥"), ["⁺", "🔥"]);
    assert.equal(renderable("Ca⁺⁺ 🔥 ok"), "Ca□□ □ ok");
  });

  await check("quality gate: a complete, reviewed-ready post has no blocking issue", () => {
    assert.deepEqual(codes(gateInput()).filter((c) => c.startsWith("error")), []);
  });

  await check("quality gate: each defect is caught with the right severity", () => {
    const opt = (o: Partial<typeof snap>) => gateInput({ snapshot: { ...snap, ...o } });
    assert.ok(codes(gateInput({ currentHash: "other" })).includes("error:SOURCE_CHANGED"));
    assert.ok(codes(gateInput({ currentHash: null })).includes("error:SOURCE_DELETED"));
    assert.ok(codes(opt({ text: "ll are types of RCT except:" })).includes("warning:STEM_TRUNCATED"));
    assert.ok(codes(opt({ options: snap.options.map((o) => ({ ...o, isCorrect: false })) })).includes("error:ANSWER_KEY"));
    assert.ok(codes(opt({ options: snap.options.map((o, i) => (i === 2 ? { ...o, text: "" } : o)) })).includes("error:OPTION_EMPTY"));
    assert.ok(codes(opt({ options: snap.options.map((o, i) => (i === 2 ? { ...o, text: "Phenytoin" } : o)) })).includes("error:OPTION_DUPLICATE"));
    assert.ok(codes(opt({ hasImages: true })).includes("error:IMAGES_UNSUPPORTED"));
    assert.ok(codes(opt({ contentFormat: "RICH_V1", text: "Value of $\\frac{1}{2}$ is" })).includes("error:EQUATIONS_UNSUPPORTED"));
    assert.ok(codes(opt({ text: "Normal serum Ca⁺⁺ is" })).includes("error:GLYPHS:Question"));
    assert.ok(codes(opt({ reviewRequired: true, reviewReason: "scan" })).includes("warning:QB_REVIEW_REQUIRED"));
    assert.ok(codes(gateInput({ questionNumber: null })).includes("warning:QUESTION_NUMBER_MISSING"));
    assert.ok(codes(gateInput({ questionNumberVerified: false })).includes("warning:QUESTION_NUMBER_UNVERIFIED"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), hookText: "" } })).includes("error:SLIDE_MISSING:0"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), caption: "" } })).includes("error:CAPTION_EMPTY"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), caption: "Most repeated PYQ" } })).includes("error:SAFETY:Caption:UNSUPPORTED_FREQUENCY_CLAIM"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), explanation: "Correct answer is A" } })).includes("error:SAFETY:Explanation:ANSWER_CONTRADICTION"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), hookText: "🔥 Can you solve it?" } })).includes("error:GLYPHS:Hook"));
    assert.ok(!codes(gateInput({ content: { ...goodContent(), caption: "Can you solve it? 🔥" } })).some((c) => c.includes("GLYPHS")), "captions may use emoji");
    assert.ok(codes(gateInput({ content: { ...goodContent(), origin: { kind: "ai" } } })).includes("warning:AI_CONTENT"));
    assert.ok(codes(gateInput({ content: { ...goodContent(), aiFlags: ["x"] } })).includes("warning:AI_FLAG:0"));
    assert.ok(codes(gateInput({ follow: { instagramHandle: "", showInstagram: true, telegramUrl: "", showTelegram: false } })).includes("error:FOLLOW_NO_INSTAGRAM"));
    assert.ok(codes(gateInput({ series: "MOST_MISSED", seriesStats: null })).includes("error:STATS_MISSING"));
    assert.ok(codes(gateInput({ snapshot: { ...snap, questionType: "MATCH_THE_FOLLOWING" } })).includes("error:TYPE_UNSUPPORTED"));
  });

  await check("text fitting: long stems overflow (blocking) instead of shrinking below readable size", () => {
    assert.equal(estimateLines("a ".repeat(10), 40, 900), 1);
    const long = { ...snap, text: "word ".repeat(220) };
    const plan = planSlides(long, goodContent(), defaultDesign());
    assert.equal(plan[1].overflow, true);
    assert.equal(planSlides(snap, goodContent(), defaultDesign()).some((p) => p.overflow), false);
  });

  await check("prefill from the student AI explanation passes the same safety checks", () => {
    const r = prefillFromReference(snap, emptyContent(), { concept: "The answer is C because…", memoryTrick: "ETHO", pointsToRemember: ["ok point", "asked every year"], reviewed: false, isStale: false });
    assert.deepEqual(r.used, ["Memory Trick", "Quick Revision"]);
    assert.deepEqual(r.skipped, ["Explanation"]);
    assert.deepEqual(r.content.quickRevision, ["ok point"]);
    assert.ok(r.content.aiFlags.some((f) => /no admin has reviewed/.test(f)));
  });

  await check("role permissions: only MASTER_ADMIN holds instagram:manage", () => {
    assert.ok(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.INSTAGRAM_MANAGE));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.INSTAGRAM_MANAGE));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.INSTAGRAM_MANAGE));
  });

  await check("renderer: every template and slide count → 1080×1350 baseline JPEG, offline", async () => {
    for (const template of ["midnight", "academic", "clinical", "premium"] as const) {
      for (const n of [3, 4, 5, 6] as const) {
        const design = defaultDesign(template, n);
        for (let i = 0; i < n; i++) {
          const jpeg = await renderSlideJpeg({ ...SAMPLE_INPUT, design, settings: SAMPLE_SETTINGS }, i);
          const meta = await sharp(jpeg).metadata();
          assert.equal(meta.format, "jpeg");
          assert.equal(meta.width, 1080);
          assert.equal(meta.height, 1350);
          assert.ok(jpeg.length < 8 * 1024 * 1024);
        }
      }
    }
    assert.deepEqual(fetches, [], "renderer made network requests");
  });
}

// ---------------------------------------------------------------------------
async function questionFingerprint(examIds: string[]): Promise<string> {
  const rows = await prisma.question.findMany({
    where: { examId: { in: examIds } },
    orderBy: { code: "asc" },
    select: { id: true, code: true, text: true, status: true, reviewRequired: true, updatedAt: true, previousYearPaperId: true, options: { orderBy: { label: "asc" }, select: { id: true, label: true, text: true, isCorrect: true, imageUrl: true, order: true } }, aiExplanation: { select: { content: true, updatedAt: true, adminReviewedAt: true } } },
  });
  const papers = await prisma.previousYearPaper.findMany({ where: { examId: { in: examIds } }, orderBy: { id: "asc" } });
  const attempts = await prisma.answer.findMany({ where: { questionId: { in: rows.map((r) => r.id) } }, orderBy: { id: "asc" }, select: { id: true, isCorrect: true, selectedOptionLabel: true } });
  return crypto.createHash("sha256").update(JSON.stringify({ rows, papers, attempts })).digest("hex");
}

async function partB() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.includes("igstudio")) {
    console.log("Part B — skipped (needs a scratch DB whose name contains 'igstudio')");
    return;
  }
  console.log(`Part B — drafts, review, Most Missed on scratch DB ${dbName}`);
  const posts = await import("@/lib/instagram/posts");
  const { getMostMissed, parseMostMissedFilters, statsForQuestion } = await import("@/lib/instagram/most-missed");
  const { buildSnapshot } = await import("@/lib/instagram/snapshot");
  const { getPaperDetail, listPapersByYear, listPyqExams } = await import("@/lib/instagram/queries");

  const exams = await prisma.exam.findMany({ where: { code: { in: ["IGFIX-RUHS", "IGFIX-RPSC"] } } });
  assert.equal(exams.length, 2, "run scripts/ig-studio-fixture.ts setup first");
  const examIds = exams.map((e) => e.id);
  const ruhs = exams.find((e) => e.code === "IGFIX-RUHS")!;
  const q = async (code: string) => prisma.question.findUniqueOrThrow({ where: { code } });
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  const actorId = admin.id;
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: (await prisma.question.findMany({ where: { examId: { in: examIds } }, select: { id: true } })).map((x) => x.id) } } });
  const { saveStudioSettings } = await import("@/lib/instagram/config");
  await saveStudioSettings({ instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries_fixture" });
  const before = await questionFingerprint(examIds);
  const auditBefore = await prisma.auditLog.count();

  const good = await q("IGFIX-RUHS21-W01");

  await check("PYQ selector: exam → year → paper → stored order; same-year papers are told apart", async () => {
    const list = await listPyqExams();
    assert.ok(list.some((e) => e.id === ruhs.id && e.paperCount === 2));
    const years = await listPapersByYear(ruhs.id);
    assert.deepEqual(years.map((y) => y.year), [2021, 2019]);
    const p = await getPaperDetail(years[0].papers[0].id);
    assert.deepEqual(p!.questions.map((x) => x.code), ["IGFIX-RUHS21-W01", "IGFIX-RUHS21-W02", "IGFIX-RUHS21-W03", "IGFIX-RUHS21-W04", "IGFIX-RUHS21-W05", "IGFIX-RUHS21-W06", "IGFIX-RUHS21-W07"]);
    assert.deepEqual(p!.questions.map((x) => x.position), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(p!.questions[1].flags, ["CHECK_TEXT", "QB_REVIEW"]);
    assert.deepEqual(p!.questions[2].flags, ["HAS_IMAGE"]);
    assert.deepEqual(p!.questions[3].flags, ["ANSWER_KEY"]);
    assert.deepEqual(p!.questions[4].flags, [], "Greek opening is not OCR damage");
    assert.equal(p!.questions[0].aiExplanation, "REVIEWED");
    assert.ok(p!.questions.every((x) => x.instagram.status === "NOT_CREATED"));
    const rpscQ = await buildSnapshot((await q("IGFIX-RPSC24I-W01")).id);
    assert.equal(rpscQ!.snapshot.paperSharesYear, true);
    assert.equal((await buildSnapshot(good.id))!.snapshot.paperSharesYear, false);
    assert.equal((await buildSnapshot((await q("IGFIX-RUHS21-W03")).id))!.snapshot.importPosition, 3);
  });

  let postId = "";
  await check("create draft: frozen snapshot + hash, revision 1, audit logged; second create returns the same post", async () => {
    const r = await posts.createDraft({ questionId: good.id, series: "PYQ", stats: null, actorId });
    assert.equal(r.existed, false);
    postId = r.post.id;
    assert.equal(r.post.status, "DRAFT");
    assert.equal(r.post.revision, 1);
    assert.equal(r.post.snapshot.text, good.text);
    assert.deepEqual(r.post.snapshot.options.filter((o) => o.isCorrect).map((o) => o.label), ["B"]);
    assert.equal(r.post.sourceChanged, false);
    const again = await posts.createDraft({ questionId: good.id, series: "PYQ", stats: null, actorId });
    assert.equal(again.existed, true);
    assert.equal(again.post.id, postId);
  });

  await check("duplicate protection: 6 concurrent creates for one question → exactly one current post", async () => {
    const other = await q("IGFIX-RUHS21-W05");
    const results = await Promise.all(Array.from({ length: 6 }, () => posts.createDraft({ questionId: other.id, series: "PYQ", stats: null, actorId })));
    assert.equal(new Set(results.map((r) => r.post.id)).size, 1);
    assert.equal(results.filter((r) => !r.existed).length, 1);
    assert.equal(await prisma.instagramPost.count({ where: { questionId: other.id } }), 1);
  });

  await check("non-PYQ question can't start a PYQ draft; Most Missed needs numbers", async () => {
    const practice = await q("IGFIX-QB-0001");
    await assert.rejects(posts.createDraft({ questionId: practice.id, series: "PYQ", stats: null, actorId }), /not linked to a previous year paper/);
    await assert.rejects(posts.createDraft({ questionId: practice.id, series: "MOST_MISSED", stats: null, actorId }), /numbers are required/);
  });

  await check("quality gate on real fixture questions", async () => {
    const issueCodes = async (code: string) => {
      const qq = await q(code);
      const r = await posts.createDraft({ questionId: qq.id, series: "PYQ", stats: null, actorId });
      return r.post.issues.map((i) => `${i.severity}:${i.code}`);
    };
    assert.ok((await issueCodes("IGFIX-RUHS21-W02")).includes("warning:STEM_TRUNCATED"));
    assert.ok((await issueCodes("IGFIX-RUHS21-W03")).includes("error:IMAGES_UNSUPPORTED"));
    assert.ok((await issueCodes("IGFIX-RUHS21-W04")).includes("error:ANSWER_KEY"));
    const long = await issueCodes("IGFIX-RUHS21-W06");
    assert.ok(long.includes("error:SLIDE_OVERFLOW:1"), long.join(","));
    assert.ok((await issueCodes("IGFIX-RUHS21-W07")).includes("error:GLYPHS:Question"));
    assert.ok(!(await issueCodes("IGFIX-RUHS21-W05")).some((c) => c.startsWith("error:GLYPHS")), "Greek renders via the fallback font");
  });

  let rev = 1;
  await check("AI generation (stubbed provider): fills fields, origin=ai, saved as a revision; contradicting output changes nothing", async () => {
    const dto = await posts.getPostDto(postId);
    const reply = {
      answerLabel: "B",
      hooks: [
        { style: "curiosity", text: "Can You Solve This RUHS MO PYQ?" },
        { style: "challenge", text: "One Question Every MO Aspirant Should Revise" },
        { style: "memory", text: "Remember This Concept in 10 Seconds" },
      ],
      explanation: "Ethosuximide blocks T-type calcium channels in thalamic neurons, the source of the 3 Hz spike-and-wave rhythm in absence seizures.",
      memoryTrick: "ETHO = Empty THOughts: the child stares blankly.",
      clinicalPearl: "Valproate is preferred when absence seizures coexist with generalized tonic-clonic seizures.",
      quickRevision: ["T-type Ca channel blocker", "EEG: 3 Hz spike-and-wave"],
      finalTrick: "Absence = Ethosuximide",
      caption: "Can you solve this RUHS MO 2021 PYQ?\nComment your answer below and save this post for revision.",
      hashtags: ["#RUHSMO", "#Pharmacology", "#MedicalOfficer"],
      confidence: "high",
      concerns: [],
    };
    const prompts: string[] = [];
    const out = await generateContent({
      snapshot: dto.snapshot,
      series: "PYQ",
      stats: null,
      current: dto.content,
      targets: ["hooks", "explanation", "memoryTrick", "clinicalPearl", "quickRevision", "finalTrick", "caption", "hashtags"],
      reference: await getAiReference(good.id),
      allowedDomains: ["mocktestseries.in"],
      generator: async (prompt) => (prompts.push(prompt), { text: "```json\n" + JSON.stringify(reply) + "\n```", provider: "gemini" as const, model: "stub" }),
    });
    assert.equal(out.changed.length, 8);
    assert.equal(out.content.hookText, "Can You Solve This RUHS MO PYQ?");
    assert.equal(out.content.origin.kind, "ai");
    assert.ok(prompts[0].includes("Unreviewed reference notes"));
    const saved = await posts.applyChange({ postId, expectedRevision: 1, content: out.content, note: "AI: all", actorId });
    rev = saved.revision;
    assert.equal(rev, 2);
    await assert.rejects(
      generateContent({ snapshot: dto.snapshot, series: "PYQ", stats: null, current: saved.content, targets: ["explanation"], reference: null, allowedDomains: [], generator: async () => ({ text: JSON.stringify({ answerLabel: "A", explanation: "x" }), provider: "gemini" as const, model: "stub" }) }),
      /disagreed with the stored answer key/
    );
    assert.equal((await posts.getPostDto(postId)).revision, 2);
  });

  await check("optimistic concurrency: a save based on an old revision is refused", async () => {
    await assert.rejects(posts.applyChange({ postId, expectedRevision: 1, note: "stale tab", actorId }), /changed in another window/);
  });

  await check("undo walks back exactly one change; restore re-applies any revision", async () => {
    const edited = await posts.applyChange({ postId, expectedRevision: rev, content: { ...(await posts.getPostDto(postId)).content, memoryTrick: "Edited trick" }, note: "manual edit", actorId });
    assert.equal(edited.content.memoryTrick, "Edited trick");
    const undone = await posts.undoLast(postId, edited.revision, actorId);
    assert.equal(undone.content.memoryTrick, "ETHO = Empty THOughts: the child stares blankly.");
    assert.equal(undone.revision, edited.revision + 1);
    const restored = await posts.restoreRevision(postId, undone.revision, edited.revision, actorId);
    assert.equal(restored.content.memoryTrick, "Edited trick");
    const back = await posts.undoLast(postId, restored.revision, actorId);
    rev = back.revision;
    assert.equal(back.content.memoryTrick, "ETHO = Empty THOughts: the child stares blankly.");
  });

  await check("printed question number: shown only when verified; stored order never used", async () => {
    const r = await posts.setQuestionNumber(postId, rev, 12, false, actorId);
    assert.ok(r.issues.some((i) => i.code === "QUESTION_NUMBER_UNVERIFIED"));
    const v = await posts.setQuestionNumber(postId, r.revision, 12, true, actorId);
    rev = v.revision;
    assert.equal(v.questionNumberVerified, true);
    assert.ok(!v.issues.some((i) => i.code.startsWith("QUESTION_NUMBER")));
    await assert.rejects(posts.setQuestionNumber(postId, rev, 0, true, actorId), /between 1 and 500/);
  });

  await check("Mark Ready: refused without checklist + acknowledgements; approved with them; edit then needs confirmation and reverts to Draft", async () => {
    const dto = await posts.getPostDto(postId);
    assert.equal(dto.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(dto.issues));
    const warn = dto.issues.filter((i) => i.severity === "warning").map((i) => i.code);
    assert.ok(warn.includes("AI_CONTENT"));
    const refused = await posts.markReady({ postId, expectedRevision: rev, checklist: {}, acknowledged: [], actorId });
    assert.equal(refused.post.status, "DRAFT");
    assert.equal(refused.missingChecklist.length, REVIEW_CHECKLIST.length);
    assert.deepEqual(refused.missingAcks.sort(), [...warn].sort());
    const all = Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true]));
    const ok = await posts.markReady({ postId, expectedRevision: rev, checklist: all, acknowledged: warn, actorId });
    assert.equal(ok.post.status, "READY");
    assert.equal(ok.post.reviewedBy, "IG Master");
    await assert.rejects(posts.applyChange({ postId, expectedRevision: rev, note: "edit", actorId }), (e: Error & { kind?: string }) => e.kind === "needs-confirm");
    const reverted = await posts.applyChange({ postId, expectedRevision: rev, content: { ...ok.post.content, clinicalPearl: "Edited pearl." }, note: "edit after approval", actorId, confirmReplaceApproved: true });
    assert.equal(reverted.status, "DRAFT");
    assert.equal(reverted.reviewedAt, null);
    rev = reverted.revision;
    const again = await posts.markReady({ postId, expectedRevision: rev, checklist: all, acknowledged: warn, actorId });
    assert.equal(again.post.status, "READY");
  });

  await check("source change in the Question Bank blocks approval until the snapshot is refreshed (fixture row, restored after)", async () => {
    const original = good.text;
    await prisma.question.update({ where: { id: good.id }, data: { text: original + " (edited)" } });
    try {
      const dto = await posts.getPostDto(postId);
      assert.equal(dto.sourceChanged, true);
      assert.ok(dto.issues.some((i) => i.code === "SOURCE_CHANGED" && i.severity === "error"));
    } finally {
      await prisma.question.update({ where: { id: good.id }, data: { text: original, updatedAt: good.updatedAt } });
    }
    const restored = await posts.getPostDto(postId);
    assert.equal(restored.sourceChanged, false);
  });

  await check("slides of a saved post render offline as 1080×1350 JPEG", async () => {
    const dto = await posts.getPostDto(postId);
    const { getStudioSettings } = await import("@/lib/instagram/config");
    const settings = await getStudioSettings();
    for (let i = 0; i < dto.design.modules.length; i++) {
      const jpeg = await renderSlideJpeg({ snapshot: dto.snapshot, content: dto.content, design: dto.design, series: dto.series, seriesStats: dto.seriesStats, questionNumber: dto.questionNumber, questionNumberVerified: dto.questionNumberVerified, settings }, i);
      const m = await sharp(jpeg).metadata();
      assert.deepEqual([m.format, m.width, m.height], ["jpeg", 1080, 1350]);
    }
    assert.deepEqual(fetches, []);
  });

  await check("Most Missed: Question Insights numbers, IST yesterday/today, thresholds, sorting, no student identity", async () => {
    const yesterday = await getMostMissed(parseMostMissedFilters({ range: "yesterday", min: "5", examId: ruhs.id }));
    const by = new Map(yesterday.rows.map((r) => [r.code, r]));
    assert.deepEqual([by.get("IGFIX-RUHS19-W01")?.attempts, by.get("IGFIX-RUHS19-W01")?.wrong], [10, 7]);
    assert.deepEqual([by.get("IGFIX-RUHS19-W02")?.attempts, by.get("IGFIX-RUHS19-W02")?.wrong], [10, 4]);
    assert.deepEqual([by.get("IGFIX-QB-0001")?.attempts, by.get("IGFIX-QB-0001")?.wrong], [10, 6]);
    assert.deepEqual([by.get("IGFIX-RUHS21-W01")?.attempts, by.get("IGFIX-RUHS21-W01")?.wrong], [6, 5], "unanswered excluded");
    assert.deepEqual(yesterday.rows.map((r) => r.code), ["IGFIX-RUHS19-W01", "IGFIX-QB-0001", "IGFIX-RUHS21-W01", "IGFIX-RUHS19-W02"]);
    const min10 = await getMostMissed(parseMostMissedFilters({ range: "yesterday", min: "10", examId: ruhs.id }));
    assert.ok(!min10.rows.some((r) => r.code === "IGFIX-RUHS21-W01"));
    const pct = await getMostMissed(parseMostMissedFilters({ range: "yesterday", min: "5", examId: ruhs.id, minPct: "60", sort: "wrongPct" }));
    assert.deepEqual(pct.rows.map((r) => [r.code, Math.round(r.wrongPct)]), [["IGFIX-RUHS21-W01", 83], ["IGFIX-RUHS19-W01", 70], ["IGFIX-QB-0001", 60]]);
    const minWrong = await getMostMissed(parseMostMissedFilters({ range: "yesterday", min: "5", examId: ruhs.id, minWrong: "5" }));
    assert.deepEqual(minWrong.rows.map((r) => r.code), ["IGFIX-RUHS19-W01", "IGFIX-QB-0001", "IGFIX-RUHS21-W01"]);
    const today = await getMostMissed(parseMostMissedFilters({ range: "today", min: "1", examId: ruhs.id }));
    assert.deepEqual(today.rows.map((r) => [r.code, r.attempts, r.wrong]), [["IGFIX-RUHS19-W02", 3, 3]]);
    const week = await getMostMissed(parseMostMissedFilters({ range: "7d", min: "1", examId: ruhs.id }));
    assert.deepEqual([week.rows.find((r) => r.code === "IGFIX-RUHS19-W02")?.attempts, week.rows.find((r) => r.code === "IGFIX-RUHS19-W02")?.wrong], [13, 7]);
    const keys = new Set(yesterday.rows.flatMap((r) => Object.keys(r)));
    for (const k of ["studentId", "student", "name", "email", "mobile", "attemptId"]) assert.ok(!keys.has(k), `row exposes ${k}`);
    const fixtureNames = JSON.stringify(yesterday);
    assert.ok(!/IG Fixture Student|IGFIX-S0/.test(fixtureNames));
  });

  await check("Most Missed draft: numbers recomputed server-side and frozen on the post", async () => {
    const f = parseMostMissedFilters({ range: "yesterday", min: "5", examId: ruhs.id });
    const mm1 = await q("IGFIX-RUHS19-W01");
    const stats = await statsForQuestion(f, mm1.id);
    assert.deepEqual([stats?.attempts, stats?.wrong, stats?.wrongPct, stats?.rangeLabel, stats?.headlineSuffix], [10, 7, 70, "Yesterday", "YESTERDAY"]);
    const r = await posts.createDraft({ questionId: mm1.id, series: "MOST_MISSED", stats, actorId });
    assert.equal(r.post.series, "MOST_MISSED");
    assert.equal(r.post.seriesStats?.wrong, 7);
    assert.equal(await statsForQuestion(parseMostMissedFilters({ range: "today", min: "1", examId: ruhs.id }), mm1.id), null);
  });

  await check("published question: 'Instagram ✓ Posted', locked, duplicate prevented, new version supersedes, delete restores", async () => {
    // Publishing is not built: simulate a published row directly (scratch DB only).
    await prisma.instagramPost.update({ where: { id: postId }, data: { status: "PUBLISHED", publishedAt: new Date(), igMediaId: "fixture-media", igPermalink: "https://www.instagram.com/p/fixture/" } });
    const st = (await posts.statusesFor([good.id])).get(good.id)!;
    assert.deepEqual([st.status, st.posted], ["PUBLISHED", true]);
    const again = await posts.createDraft({ questionId: good.id, series: "PYQ", stats: null, actorId });
    assert.equal(again.existed, true);
    assert.equal(again.post.id, postId);
    const p = await posts.getPostDto(postId);
    await assert.rejects(posts.applyChange({ postId, expectedRevision: p.revision, note: "x", actorId }), /published post can't be edited/);
    const v2 = await posts.createNewVersion(postId, actorId);
    assert.deepEqual([v2.version, v2.status, v2.revision], [2, "DRAFT", 1]);
    await assert.rejects(posts.createNewVersion(postId, actorId), /newer version already exists/);
    const st2 = (await posts.statusesFor([good.id])).get(good.id)!;
    assert.deepEqual([st2.status, st2.posted], ["DRAFT", true]);
    const state = await posts.getQuestionPostState(good.id);
    assert.deepEqual(state.history.map((h) => [h.version, h.status, Boolean(h.supersededAt)]), [[2, "DRAFT", false], [1, "PUBLISHED", true]]);
    await posts.deleteDraft(v2.id, actorId);
    const st3 = (await posts.statusesFor([good.id])).get(good.id)!;
    assert.deepEqual([st3.status, st3.postId], ["PUBLISHED", postId]);
    await assert.rejects(posts.deleteDraft(postId, actorId), /Only Draft or Ready/);
  });

  await check("audit trail written for every studio change", async () => {
    const n = await prisma.auditLog.count({ where: { entityType: "InstagramPost", createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
    assert.ok(n >= 8, `only ${n} audit rows`);
    assert.ok((await prisma.auditLog.count()) > auditBefore);
  });

  await check("NO modification to questions, options, answers, papers or AI explanations", async () => {
    assert.equal(await questionFingerprint(examIds), before);
  });
}

async function main() {
  await partA();
  await partB();
  assert.deepEqual(fetches, [], `network requests: ${fetches.join(", ")}`);
  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
