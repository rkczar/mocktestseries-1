/**
 * Instagram Studio repair — browser-test fixture (SYNTHETIC data, scratch DB
 * only). Adds, on top of scripts/ig-studio-fixture.ts:
 *  - IGFIX-REPAIR-UI: a PYQ question imported with the legacy difficulty
 *    code "E", and its Draft reproducing the screenshot problems (AI text
 *    with U+2011 and "⁺", an AI note, no hook selected, no printed number);
 *  - Follow-slide settings, and a mock Claude key (scripts/mock-anthropic.mjs)
 *    so "Generate with AI" never reaches a real provider.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-repair-fixture.ts setup|cleanup|key <valid|overload>
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { saveClaudeKey, saveClaudeSettings } from "@/lib/anthropic-config";
import { applyChange, createDraft } from "@/lib/instagram/posts";
import { normalizeDesign, type PostContent } from "@/lib/instagram/types";
import { mockKey } from "./mock-anthropic.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (process.env.ANTHROPIC_TEST_BASE_URL === undefined && process.argv[2] !== "cleanup") console.warn("note: the server must run with ANTHROPIC_TEST_BASE_URL pointing at the mock.");

export const CODE = "IGFIX-REPAIR-UI";
const NBH = "‑";

async function cleanup() {
  const qs = await prisma.question.findMany({ where: { code: { startsWith: "IGFIX-REPAIR-" } }, select: { id: true } });
  const ids = qs.map((q) => q.id);
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: ids } } });
  await prisma.questionOption.deleteMany({ where: { questionId: { in: ids } } });
  await prisma.question.deleteMany({ where: { id: { in: ids } } });
  await prisma.setting.deleteMany({ where: { key: { in: ["api.anthropic", "ai.gateway"] } } });
  console.log(`cleanup: ${ids.length} repair questions removed`);
}

async function setup() {
  await cleanup();
  const actor = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "IGFIX-RUHS" } });
  const paper = await prisma.previousYearPaper.findFirstOrThrow({ where: { examId: exam.id, year: 2021 } });
  const tpl = await prisma.question.findFirstOrThrow({ where: { examId: exam.id, previousYearPaperId: paper.id, status: "PUBLISHED", reviewRequired: false }, select: { subjectId: true, topicId: true } });
  const q = await prisma.question.create({
    data: {
      code: CODE,
      examId: exam.id,
      subjectId: tpl.subjectId,
      topicId: tpl.topicId,
      previousYearPaperId: paper.id,
      text: "What is the imaging of choice for suspected acute osteomyelitis?",
      status: "PUBLISHED",
      difficulty: "MEDIUM",
      reviewRequired: true,
      reviewReason: 'Difficulty "E" not recognized, will default to MEDIUM',
      options: { create: [["A", "CT scan"], ["B", "X-ray"], ["C", "Ultrasonography"], ["D", "MRI"]].map(([label, text], order) => ({ label, text, isCorrect: label === "D", order })) },
    },
  });
  const { post } = await createDraft({ questionId: q.id, series: "PYQ", stats: null, actorId: actor.id });
  const content: PostContent = {
    ...post.content,
    hooks: [
      { style: "curiosity", text: "Can You Identify the Best Scan for Acute Osteomyelitis?" },
      { style: "challenge", text: "One Question Every MO Aspirant Should Revise" },
      { style: "memory", text: "Remember This Concept in 10 Seconds" },
    ],
    hookText: "",
    explanation: `MRI is the imaging of choice for acute osteomyelitis because it shows bone marrow edema early. X${NBH}ray is insensitive early.`,
    memoryTrick: "MRI = Marrow Inflammation Revealed Instantly",
    clinicalPearl: "Early MRI shows marrow edema before radiographic changes appear.",
    quickRevision: [`MRI detects marrow edema early, before X${NBH}ray changes.`, "Serum Ca²⁺ is normal"],
    caption: "Acute osteomyelitis: which scan?\nComment your answer and save this post.",
    hashtags: ["#Radiology", "#MOExam"],
    origin: { kind: "ai", provider: "fixture", model: "fixture", generatedAt: new Date().toISOString() },
    aiFlags: ["Verify that MRI is indeed the recommended imaging for acute osteomyelitis in the exam syllabus."],
  };
  const design = { ...normalizeDesign(post.design), template: "hw-doctor" as const, modules: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "PEARL_REVISION", "FOLLOW"] as never, slideCount: 6 };
  const done = await applyChange({ postId: post.id, expectedRevision: post.revision, content, design, note: "Fixture: AI draft (screenshot reproduction)", actorId: actor.id });
  await prisma.setting.upsert({
    where: { key: "instagram.studio" },
    create: { key: "instagram.studio", value: { instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries", showInstagram: true, showTelegram: true } },
    update: { value: { instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries", showInstagram: true, showTelegram: true } },
  });
  await setKey("valid");
  console.log(`setup: question ${q.id}, post ${done.id} revision ${done.revision}`);
}

async function setKey(scenario: string) {
  await saveClaudeKey(mockKey(scenario));
  await saveClaudeSettings({ enabled: true });
  console.log(`claude mock key: ${scenario}`);
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup() : cmd === "key" ? setKey(process.argv[3] ?? "valid") : Promise.reject(new Error("usage: setup|cleanup|key <scenario>")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
