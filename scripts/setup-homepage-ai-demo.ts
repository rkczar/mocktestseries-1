/**
 * One-time setup for the Homepage "Try AI Now" mini test: picks 10 diverse,
 * published RUHS MO questions, generates + caches an AI explanation for any
 * that don't have one yet (via the existing admin AI generation service —
 * the same code path /admin/ai/solutions uses), marks each reviewed, and
 * curates them as the homepage demo selection. Anonymous homepage traffic
 * only ever reads the resulting cached AIExplanation rows afterward.
 *
 * Run with:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/setup-homepage-ai-demo.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getOrCreateExplanation, markExplanationReviewed } from "@/lib/ai-explanation";
import { saveAiSettings } from "@/lib/ai-settings";

const TARGET_COUNT = 10;
const ADMIN_USER_EMAIL = "drrkm18@gmail.com";

async function main() {
  const exam = await prisma.exam.findFirst({
    where: { publicSlug: "rajasthan-medical-officer" },
    select: { id: true, name: true },
  });
  if (!exam) throw new Error("RUHS exam not found");

  const admin = await prisma.adminUser.findUnique({ where: { email: ADMIN_USER_EMAIL }, select: { id: true } });
  if (!admin) throw new Error("Admin user not found");

  // Prefer one question per subject for variety, published, no existing AI
  // explanation needed strictly — up to TARGET_COUNT, ordered by subject.
  const candidates = await prisma.question.findMany({
    where: {
      examId: exam.id,
      status: "PUBLISHED",
      parentQuestionId: null,
    },
    select: { id: true, code: true, text: true, subject: { select: { name: true } } },
    orderBy: { code: "asc" },
    take: 200,
  });

  const seenSubjects = new Set<string>();
  const picked: typeof candidates = [];
  for (const q of candidates) {
    const subj = q.subject.name;
    if (seenSubjects.has(subj)) continue;
    if (q.text.length > 320) continue;
    seenSubjects.add(subj);
    picked.push(q);
    if (picked.length >= TARGET_COUNT) break;
  }
  // Top up if fewer than TARGET_COUNT distinct subjects qualified.
  if (picked.length < TARGET_COUNT) {
    for (const q of candidates) {
      if (picked.find((p) => p.id === q.id)) continue;
      if (q.text.length > 320) continue;
      picked.push(q);
      if (picked.length >= TARGET_COUNT) break;
    }
  }

  console.log(`Picked ${picked.length} questions:`);
  picked.forEach((q) => console.log(`  ${q.code} — ${q.subject.name} — ${q.text.slice(0, 60)}...`));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const finalIds: string[] = [];
  for (const q of picked) {
    process.stdout.write(`Generating explanation for ${q.code}... `);
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        await getOrCreateExplanation(q.id);
        await markExplanationReviewed(q.id, admin.id);
        finalIds.push(q.id);
        console.log("done.");
        ok = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt === 4) {
          console.log(`FAILED after ${attempt} attempts: ${msg}`);
        } else {
          process.stdout.write(`retrying (${msg.slice(0, 60)})... `);
          await sleep(20_000);
        }
      }
    }
    // Free-tier Gemini rate limit is 5 requests/minute — always pace calls.
    await sleep(15_000);
  }

  await saveAiSettings({ homepageDemoEnabled: true, homepageDemoQuestionIds: finalIds });
  console.log(`\nHomepage AI demo selection saved: ${finalIds.length}/${TARGET_COUNT} questions cached & curated.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
