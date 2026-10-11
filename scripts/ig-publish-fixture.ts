/**
 * Direct publishing — fixture helper for the browser suite. Creates a fresh,
 * publishable DRAFT (no blocking issues) for a fixture question and prints its
 * id. `legacy-ready` stores it with the old READY status (pre single-confirm
 * rows). Scratch *igstudio* databases only; needs scripts/ig-studio-fixture.ts
 * setup first. `batch <code...>` makes a Bulk Studio batch of completed drafts
 * and prints the batch id.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-publish-fixture.ts draft|ready|legacy-ready <questionCode>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-publish-fixture.ts batch <questionCode> <questionCode>…
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import * as posts from "@/lib/instagram/posts";
import { setPublishingSwitch } from "@/lib/instagram/publish";
import { createBatch } from "@/lib/instagram/batch";
import type { PostContent } from "@/lib/instagram/types";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}

/** Fills a draft with short manual content so it has no blocking issue; returns its id. */
async function complete(postId: string, code: string, actorId: string): Promise<string> {
  const post = await posts.getPostDto(postId);
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
  const saved = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content, note: "fixture content", actorId });
  const dto = await posts.getPostDto(saved.id);
  const blocking = dto.issues.filter((i) => i.severity === "error");
  if (blocking.length) throw new Error(`fixture post has blocking issues: ${JSON.stringify(blocking)}`);
  return dto.id;
}

async function main() {
  const [cmd, code, ...more] = process.argv.slice(2);
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  if (cmd === "switch-off") {
    await setPublishingSwitch(false, admin.id);
    return;
  }
  if (cmd === "batch") {
    const codes = [code, ...more].filter(Boolean);
    const qs = await prisma.question.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
    await prisma.instagramPost.deleteMany({ where: { questionId: { in: qs.map((q) => q.id) } } });
    const r = await createBatch({ name: "UI fixture batch", examId: null, questionIds: codes.map((c) => qs.find((q) => q.code === c)!.id), template: "default", actorId: admin.id });
    for (const it of r.results) await complete(it.postId!, qs.find((q) => q.id === it.questionId)!.code, admin.id);
    console.log(r.batchId);
    return;
  }
  // "ready" is the old name of "draft" (kept so older scripts keep working).
  if (!["draft", "ready", "legacy-ready"].includes(cmd) || !code) throw new Error("usage: draft|legacy-ready <questionCode> | switch-off");
  const q = await prisma.question.findUniqueOrThrow({ where: { code } });
  await prisma.instagramPost.deleteMany({ where: { questionId: q.id } });
  const { post } = await posts.createDraft({ questionId: q.id, series: "PYQ", stats: null, actorId: admin.id });
  const id = await complete(post.id, code, admin.id);
  const dto = await posts.getPostDto(id);
  if (cmd === "legacy-ready") {
    await prisma.instagramPost.update({
      where: { id: dto.id },
      data: { status: "READY", reviewedAt: new Date(), reviewedById: admin.id, review: { checklist: {}, acknowledged: [], revision: dto.revision, at: new Date().toISOString() } },
    });
  }
  console.log(dto.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
