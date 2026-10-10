/**
 * Direct publishing — fixture helper for the browser suite. Creates a fresh,
 * approved (READY) post for a fixture question and prints its id. Scratch
 * *igstudio* databases only; needs scripts/ig-studio-fixture.ts setup first.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-publish-fixture.ts ready <questionCode>
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import * as posts from "@/lib/instagram/posts";
import { REVIEW_CHECKLIST } from "@/lib/instagram/quality";
import { setPublishingSwitch } from "@/lib/instagram/publish";
import type { PostContent } from "@/lib/instagram/types";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}

async function main() {
  const [cmd, code] = process.argv.slice(2);
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  if (cmd === "switch-off") {
    await setPublishingSwitch(false, admin.id);
    return;
  }
  if (cmd !== "ready" || !code) throw new Error("usage: ready <questionCode> | switch-off");
  const q = await prisma.question.findUniqueOrThrow({ where: { code } });
  await prisma.instagramPost.deleteMany({ where: { questionId: q.id } });
  const { post } = await posts.createDraft({ questionId: q.id, series: "PYQ", stats: null, actorId: admin.id });
  const content: PostContent = {
    ...post.content,
    hookText: "Can You Solve This PYQ?",
    explanation: "The stored answer is correct; this fixture explanation is short and plain.",
    memoryTrick: "Fixture memory line.",
    clinicalPearl: "Fixture pearl.",
    quickRevision: ["Point one", "Point two"],
    caption: `Can you solve this ${code} PYQ? Comment your answer below.`,
    hashtags: ["#RUHSMO2026", "#MedicalOfficer", "#MedicalMCQs", "#PreviousYearQuestions", "#MockTestSeries"],
    origin: { kind: "manual" },
  };
  const saved = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content, note: "fixture content", actorId: admin.id });
  const dto = await posts.getPostDto(saved.id);
  const warn = dto.issues.filter((i) => i.severity === "warning").map((i) => i.code);
  const r = await posts.markReady({ postId: dto.id, expectedRevision: dto.revision, checklist: Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true])), acknowledged: warn, actorId: admin.id });
  if (r.post.status !== "READY") throw new Error(`not ready: ${JSON.stringify({ blocked: r.blocked, missing: r.missingAcks })}`);
  console.log(r.post.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
