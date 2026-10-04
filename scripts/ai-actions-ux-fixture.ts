/**
 * Fixture helper for scripts/verify-ai-actions-ux.mjs (Ask AI + AI Question
 * Variant actions, usage label, upgrade CTA).
 *
 *   setup   → a disposable exam with a 20-question FREE Mock whose questions
 *             already carry a cached (COMPLETED) AI explanation and 5 AI
 *             Question Variants — so Ask AI never needs a provider key — and
 *             one student per usage state, pre-seeded with today's
 *             AI_EXPLANATION_VIEWED ledger rows:
 *               nine (9 left) · five (5) · one (1) · zero (0) · fresh (10) ·
 *               paid (active entitlement to an active PAID product).
 *             Prints JSON (tokens, ids, keys, freeDailyLimit, the upgrade product).
 *   views <studentId> → prints how many distinct AI_EXPLANATION_VIEWED
 *             question ids that student has today and the per-question counts.
 *   cleanup <examId> <studentId...> → deletes everything setup created.
 *
 * Point DATABASE_URL at the DISPOSABLE database the local server uses; needs
 * AUTH_SECRET (from .env) to mint the student session cookies.
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ai-actions-ux-fixture.ts setup
 */
import "dotenv/config";
import { AiGenerationStatus, AiSlot, PrismaClient, QuestionDifficulty, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to create UI fixtures in what looks like the production database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const KEYS = ["C", "A", "D", "B"] as const;
const SLOTS = [AiSlot.AI01, AiSlot.AI02, AiSlot.AI03, AiSlot.AI04, AiSlot.AI05];

function istStartOfDay(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
}

const explanation = (n: number) => ({
  concept: `Fixture concept explanation for question ${n}.`,
  optionAnalysis: { A: "Reason A.", B: "Reason B.", C: "Reason C.", D: "Reason D." },
  pointsToRemember: ["Point one.", "Point two."],
  memoryTrick: "Fixture memory trick.",
  examinerTraps: ["Fixture trap."],
  trapWords: ["always"],
  examinerVariation: "Fixture variation.",
});

async function setup() {
  const settings = await prisma.setting.findUnique({ where: { key: "ai.settings" } });
  const freeDailyLimit = ((settings?.value as { freeDailyLimit?: number } | null)?.freeDailyLimit ?? 10) as number;
  const paidDailyLimit = (settings?.value as { paidDailyLimit?: number | null } | null)?.paidDailyLimit ?? null;

  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `AI UX Exam ${suffix}`, code: `AIUX-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "AI UX Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "AI UX Topic" });

  const base = { examId: exam.id, subjectId: subject.id, topicId: topic.id, difficulty: QuestionDifficulty.MEDIUM };
  const bank: { id: string; key: string }[] = [];
  for (let n = 1; n <= 20; n++) {
    const key = KEYS[n % KEYS.length];
    const q = await prisma.question.create({
      data: {
        ...base,
        code: `AIUX-${suffix}-${n}`,
        text: `AI UX question ${n}: which nematode infects by penetration of skin by infective larvae?`,
        status: QuestionStatus.PUBLISHED,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `Option ${label} (q${n})`, isCorrect: label === key, order })) },
        aiExplanation: { create: { content: explanation(n), model: "fixture", provider: "fixture", status: AiGenerationStatus.COMPLETED, generatedAt: new Date() } },
      },
    });
    for (const [i, slot] of SLOTS.entries()) {
      await prisma.question.create({
        data: {
          ...base,
          code: `AIUX-${suffix}-${n} ${slot}`,
          text: `Variant ${i + 1} of question ${n}: a new clinical scenario.`,
          parentQuestionId: q.id,
          aiSlot: slot,
          aiGenerationStatus: AiGenerationStatus.COMPLETED,
          options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `Variant option ${label}`, isCorrect: label === "B", order })) },
          aiExplanation: { create: { content: explanation(n), model: "fixture", provider: "fixture", status: AiGenerationStatus.COMPLETED, generatedAt: new Date() } },
        },
      });
    }
    bank.push({ id: q.id, key });
  }

  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `AI UX Mock ${suffix}`,
      durationMinutes: 60,
      status: "PUBLISHED",
      accessType: "FREE",
      questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
    },
  });

  // Cheapest active PAID product — what an "unlimited" entitlement is granted on.
  const paidProduct = await prisma.product.findFirst({ where: { isActive: true, accessType: "PAID" }, orderBy: { sellingPricePaise: "asc" } });

  const used: Record<string, number> = { nine: freeDailyLimit - 9, five: freeDailyLimit - 5, one: freeDailyLimit - 1, zero: freeDailyLimit, fresh: 0, paid: 0 };
  const tokens: Record<string, string> = {};
  const students: Record<string, string> = {};
  const todayStart = istStartOfDay(new Date());
  for (const [persona, count] of Object.entries(used)) {
    const s = await prisma.student.create({
      data: { studentId: `AIUX${persona}-${suffix}`, name: `AI UX ${persona}`, email: `aiux-${persona}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students[persona] = s.id;
    for (let i = 0; i < count; i++) {
      await prisma.studentActivity.create({
        data: { studentId: s.id, activity: "AI_EXPLANATION_VIEWED", metadata: { questionId: `seed-${suffix}-${i}`, cacheHit: true, provider: "fixture", model: "fixture" }, createdAt: new Date(todayStart.getTime() + 60_000 + i) },
      });
    }
    if (persona === "paid" && paidProduct) {
      await prisma.studentEntitlement.create({
        data: { studentId: s.id, productId: paidProduct.id, source: "ADMIN_GRANT", status: "ACTIVE", startsAt: new Date(Date.now() - 60_000), reason: "AI UX fixture" },
      });
    }
    tokens[persona] = await encode({
      token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email },
      secret: process.env.AUTH_SECRET!,
      salt: "student-session-token",
    });
  }

  console.log(
    JSON.stringify({
      examId: exam.id,
      mockId: mock.id,
      keys: bank.map((q) => q.key),
      questionIds: bank.map((q) => q.id),
      students,
      tokens,
      freeDailyLimit,
      paidDailyLimit,
      paidProduct: paidProduct ? { code: paidProduct.code } : null,
    })
  );
}

async function views(studentId: string) {
  const rows = await prisma.studentActivity.findMany({
    where: { studentId, activity: "AI_EXPLANATION_VIEWED", createdAt: { gte: istStartOfDay(new Date()) } },
    select: { metadata: true },
  });
  const perQuestion: Record<string, number> = {};
  for (const r of rows) {
    const id = (r.metadata as { questionId?: string } | null)?.questionId;
    if (id) perQuestion[id] = (perQuestion[id] ?? 0) + 1;
  }
  console.log(JSON.stringify({ rows: rows.length, distinct: Object.keys(perQuestion).length, perQuestion }));
}

async function cleanup(examId: string, studentIds: string[]) {
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.savedQuestion.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.mockTest.deleteMany({ where: { examId } });
  await prisma.question.deleteMany({ where: { examId, parentQuestionId: { not: null } } });
  await prisma.question.deleteMany({ where: { examId } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await deleteFixtureTaxonomy(prisma, [examId]);
  await prisma.exam.deleteMany({ where: { id: examId } });
  console.log("cleaned");
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "views" ? views(args[0]) : cmd === "cleanup" ? cleanup(args[0], args.slice(1)) : Promise.reject(new Error("usage: setup | views <studentId> | cleanup <examId> <studentId...>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
