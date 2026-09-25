/**
 * Verifies AI Question Variants (Ask AI → AI Question Variants → Question Bank).
 *
 * Part 1 (pure, no DB): validation + duplicate/near-duplicate detection.
 * Part 2 (disposable fixture exam, scripted provider — no real AI call and no
 * production question is touched): the real ensureQuestionVariants flow —
 * generation, auto-save to the Question Bank, AI0n codes, metadata
 * inheritance, max 5, duplicate rejection, partial results, bounded retry,
 * reuse, concurrency. Fixture rows are deleted at the end.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-variants.ts          # both parts
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-variants.ts --pure   # part 1 only
 */
import "dotenv/config";
import { validateGenerated, validateCandidate, isNearDuplicate, screenCandidates, parseCandidateBatch } from "@/lib/ai-variant-validation";

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

type Opt = { label: string; text: string; isCorrect: boolean };
function q(text: string, opts: [string, string, string, string], correct = 1, explanation = "Because.") {
  const options: Opt[] = opts.map((t, i) => ({ label: "ABCD"[i], text: t, isCorrect: i === correct }));
  return { text, options, explanation, optionAnalysis: {} };
}

const SOURCE = q("Which vitamin deficiency causes scurvy?", ["Vitamin A", "Vitamin C", "Vitamin D", "Vitamin K"]);
const DISTINCT = [
  q("A sailor on a long voyage develops bleeding gums and perifollicular haemorrhages. Supplementing which nutrient reverses this?", ["Thiamine", "Ascorbic acid", "Niacin", "Retinol"]),
  q("Impaired hydroxylation of proline in collagen synthesis is most directly caused by lack of which cofactor?", ["Ascorbate", "Pyridoxine", "Biotin", "Folate"], 0),
  q("An elderly man living alone on tea and toast presents with corkscrew hairs and poor wound healing. Which lab finding is expected?", ["Low plasma ascorbate", "Low serum B12", "High INR", "Low serum calcium"], 0),
  q("Which of these foods is the richest dietary source of the vitamin whose deficiency causes scurvy?", ["White rice", "Amla (Indian gooseberry)", "Milk", "Egg yolk"]),
  q("Scurvy in infants (Barlow disease) most characteristically presents with which feature?", ["Subperiosteal haemorrhage causing pseudoparalysis", "Night blindness", "Tetany", "Megaloblastic anaemia"], 0),
  q("Which enzyme requires vitamin C as a cofactor for norepinephrine synthesis?", ["Dopamine beta-hydroxylase", "Tyrosine hydroxylase", "MAO-A", "COMT"], 0),
];

function part1() {
  console.log("--- Part 1: validation + duplicate detection (pure) ---");
  check("well-formed candidate accepted", validateCandidate(DISTINCT[0]) !== null);
  check("legacy single-object validator still works", validateGenerated(JSON.stringify(DISTINCT[0])) !== null);
  check("malformed JSON rejected", validateGenerated("not json") === null);
  check("3 options rejected", validateCandidate({ ...DISTINCT[0], options: DISTINCT[0].options.slice(0, 3) }) === null);
  check("zero correct rejected", validateCandidate({ ...DISTINCT[0], options: DISTINCT[0].options.map((o) => ({ ...o, isCorrect: false })) }) === null);
  check("two correct rejected", validateCandidate({ ...DISTINCT[0], options: DISTINCT[0].options.map((o, i) => ({ ...o, isCorrect: i < 2 })) }) === null);
  check("duplicate option text rejected", validateCandidate({ ...DISTINCT[0], options: DISTINCT[0].options.map((o) => ({ ...o, text: o.isCorrect ? o.text : "Same" })) }) === null);
  check("empty stem rejected", validateCandidate({ ...DISTINCT[0], text: "  " }) === null);

  check("identical stem = duplicate", isNearDuplicate(SOURCE, SOURCE));
  check("case/punctuation/whitespace-only change = duplicate", isNearDuplicate(q("WHICH vitamin   deficiency causes scurvy", ["Vitamin A", "Vitamin C", "Vitamin D", "Vitamin K"]), SOURCE));
  check("options reordered, same stem = duplicate", isNearDuplicate(q("Which vitamin deficiency causes scurvy?", ["Vitamin K", "Vitamin C", "Vitamin A", "Vitamin D"]), SOURCE));
  check("superficial rewording + same options = duplicate", isNearDuplicate(q("Scurvy is caused by deficiency of which vitamin?", ["Vitamin A", "Vitamin C", "Vitamin D", "Vitamin K"]), SOURCE));
  check("option formatting ('(b) Vitamin C') ignored", isNearDuplicate(q("Which vitamin deficiency causes scurvy?", ["(a) Vitamin A", "(b) Vitamin C", "(c) Vitamin D", "(d) Vitamin K"]), SOURCE));
  check("meaningfully different variants are NOT duplicates of the source", DISTINCT.every((d) => !isNearDuplicate(d, SOURCE)));
  check("distinct variants are not duplicates of each other", DISTINCT.every((a, i) => DISTINCT.every((b, j) => i === j || !isNearDuplicate(a, b))));
  const numbersA = q("A drug has a half-life of 4 hours. What fraction remains after 12 hours?", ["1/2", "1/4", "1/8", "1/16"], 2);
  const numbersB = q("A drug has a half-life of 6 hours. What fraction remains after 24 hours?", ["1/4", "1/8", "1/16", "1/32"], 2);
  check("changed-numbers variant with a different answer is NOT a duplicate", !isNearDuplicate(numbersB, numbersA));

  const batch = parseCandidateBatch(JSON.stringify({ variants: [DISTINCT[0], DISTINCT[0], SOURCE, { junk: true }, DISTINCT[1]] }));
  const screened = screenCandidates(batch, [SOURCE], 5);
  check("batch: 5 candidates → 2 unique accepted (not padded to 5)", screened.accepted.length === 2);
  check("batch: 2 duplicates rejected (repeat + copy of source)", screened.rejectedDuplicate === 2);
  check("batch: 1 invalid rejected", screened.rejectedInvalid === 1);
  check("parser accepts fenced JSON", parseCandidateBatch("```json\n" + JSON.stringify({ variants: [DISTINCT[0]] }) + "\n```").length === 1);
}

async function part2() {
  console.log("\n--- Part 2: ensureQuestionVariants on a disposable fixture exam ---");
  const { prisma } = await import("@/lib/prisma");
  const { ensureQuestionVariants, getActiveVariants, archiveVariant, MAX_VARIANTS_PER_QUESTION } = await import("@/lib/ai-variant");
  type Gen = NonNullable<NonNullable<Parameters<typeof ensureQuestionVariants>[1]>["generate"]>;

  const suffix = Date.now().toString(36).toUpperCase();
  const exam = await prisma.exam.create({ data: { name: `ZZ Variant Fixture ${suffix}`, code: `ZZVAR-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Fixture Subject" } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: "Fixture Topic" } });

  let n = 0;
  async function makeSource() {
    n += 1;
    return prisma.question.create({
      data: {
        code: `ZZVAR ${suffix} W${String(n).padStart(2, "0")}`,
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        text: SOURCE.text,
        status: "PUBLISHED",
        examYear: 2024,
        options: { create: SOURCE.options.map((o, order) => ({ ...o, order })) },
      },
    });
  }

  const calls: number[] = [];
  /** Scripted provider: each call returns the next batch and records how many questions the prompt asked for. */
  function scripted(batches: object[][]): Gen {
    let i = 0;
    return async (prompt) => {
      calls.push(Number(prompt.match(/Write (\d+) NEW/)?.[1] ?? 0));
      const batch = batches[Math.min(i, batches.length - 1)];
      i += 1;
      await new Promise((r) => setTimeout(r, 150));
      return { text: JSON.stringify({ variants: batch }), provider: "gemini", model: "fixture-model" };
    };
  }

  try {
    // TEST 1 + 8 + 9 + 10
    const s1 = await makeSource();
    calls.length = 0;
    const r1 = await ensureQuestionVariants(s1.id, { target: 3, generate: scripted([DISTINCT.slice(0, 3)]) });
    check("T1 zero variants → 3 generated in ONE provider call", r1.generatedNow === 3 && r1.providerCalls === 1 && calls[0] === 3);
    const rows1 = await prisma.question.findMany({ where: { parentQuestionId: s1.id }, include: { options: true, aiExplanation: true }, orderBy: { aiSlot: "asc" } });
    check("T1 saved to Question Bank as PUBLISHED (no approval step)", rows1.length === 3 && rows1.every((r) => r.status === "PUBLISHED"));
    check("T1 explanation stored with each variant", r1.variants.every((v) => v.explanation === "Because.") && rows1.every((r) => r.aiExplanation?.status === "COMPLETED"));
    check("T8 source → variant relationship (parentQuestionId)", rows1.every((r) => r.parentQuestionId === s1.id));
    check("T9 codes follow existing convention '<source code> AI0n'", rows1.map((r) => r.code).join("|") === [1, 2, 3].map((k) => `${s1.code} AI0${k}`).join("|"));
    check("T10 exam/subject/topic inherited from source", rows1.every((r) => r.examId === exam.id && r.subjectId === subject.id && r.topicId === topic.id));
    check("T10 provenance: not PYQ, no PYQ paper/year", rows1.every((r) => r.source === "QUESTION_BANK" && r.previousYearPaperId === null && r.examYear === null && r.aiVariantType === "AI_SIMILAR"));
    check("T1 each variant has 4 options, exactly one correct", rows1.every((r) => r.options.length === 4 && r.options.filter((o) => o.isCorrect).length === 1));

    // TEST 5
    calls.length = 0;
    const r5 = await ensureQuestionVariants(s1.id, { target: 5, generate: scripted([DISTINCT.slice(3, 5)]) });
    check("T5 existing 3 reused, only the missing 2 requested from AI", calls[0] === 2 && r5.generatedNow === 2 && r5.variants.length === 5);
    check("T5 existing rows unchanged", r5.variants.slice(0, 3).every((v, i) => v.id === rows1[i].id));

    // TEST 6 + 2
    calls.length = 0;
    const r6 = await ensureQuestionVariants(s1.id, { target: 5, generate: scripted([[DISTINCT[5]]]) });
    check("T6 5 existing → zero provider calls, same 5 returned", calls.length === 0 && r6.providerCalls === 0 && r6.variants.length === 5);
    check("T2 never more than 5 stored", (await prisma.question.count({ where: { parentQuestionId: s1.id } })) === MAX_VARIANTS_PER_QUESTION);
    const r6b = await ensureQuestionVariants(s1.id, { target: 99, generate: scripted([[DISTINCT[5]]]) });
    check("T2 requested count clamped to 5 server-side", r6b.requested === 5 && r6b.providerCalls === 0);

    // TEST 3 + 4 + bounded retry
    const s3 = await makeSource();
    calls.length = 0;
    const dupBatch = [DISTINCT[0], DISTINCT[0], SOURCE, DISTINCT[1], q("Which vitamin deficiency causes scurvy!", ["Vitamin A", "Vitamin C", "Vitamin D", "Vitamin K"])];
    const r3 = await ensureQuestionVariants(s3.id, { target: 5, generate: scripted([dupBatch, [DISTINCT[1], DISTINCT[2]], [DISTINCT[3]]]) });
    check("T3 duplicate candidates rejected", r3.rejectedDuplicate >= 3);
    check("bounded retry: exactly 2 provider calls, the 2nd asks only for the 3 missing", calls.length === 2 && calls[0] === 5 && calls[1] === 3);
    check("T4 partial unique result kept (3 of 5), not padded", r3.variants.length === 3 && r3.generatedNow === 3);
    const texts3 = (await prisma.question.findMany({ where: { parentQuestionId: s3.id }, select: { text: true } })).map((r) => r.text);
    check("T3 no duplicate Question records", new Set(texts3).size === texts3.length && !texts3.includes(SOURCE.text));

    const sBad = await makeSource();
    const rBad = await ensureQuestionVariants(sBad.id, { target: 3, generate: scripted([[{ junk: 1 }], [SOURCE]]) });
    check("invalid output never pollutes the Question Bank", rBad.variants.length === 0 && (await prisma.question.count({ where: { parentQuestionId: sBad.id } })) === 0);

    const sFail = await makeSource();
    let threw = false;
    try {
      await ensureQuestionVariants(sFail.id, {
        target: 3,
        generate: async () => {
          throw new Error("provider down");
        },
      });
    } catch {
      threw = true;
    }
    check("provider failure → retryable error, no partial DB rows", threw && (await prisma.question.count({ where: { parentQuestionId: sFail.id } })) === 0);
    check("generation lock released after failure", (await prisma.setting.count({ where: { key: `ai.variant-generation-lock:${sFail.id}` } })) === 0);

    // TEST 7
    const s7 = await makeSource();
    calls.length = 0;
    const gen7 = scripted([DISTINCT.slice(0, 3)]);
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => ensureQuestionVariants(s7.id, { target: 3, generate: gen7 })));
    const rows7 = await prisma.question.findMany({ where: { parentQuestionId: s7.id }, select: { aiSlot: true, code: true } });
    check("T7 5 concurrent requests → exactly 3 rows, unique slots/codes", rows7.length === 3 && new Set(rows7.map((r) => r.aiSlot)).size === 3 && new Set(rows7.map((r) => r.code)).size === 3);
    check("T7 only one request called the provider", calls.length === 1 && settled.some((s) => s.status === "fulfilled"));

    const reuse = await ensureQuestionVariants(s7.id, { target: 3, generate: scripted([[DISTINCT[5]]]) });
    check("global reuse: a second requester gets the same stored variants", reuse.providerCalls === 0 && reuse.variants.length === 3);

    await archiveVariant(reuse.variants[0].id);
    check("archived variant hidden from Ask AI", (await getActiveVariants(s7.id)).length === 2);
    const refill = await ensureQuestionVariants(s7.id, { target: 3, generate: scripted([[DISTINCT[0], DISTINCT[4]]]) });
    check("archived text still blocks a regenerated duplicate; a new unique one fills a free slot", refill.variants.length === 3 && refill.rejectedDuplicate === 1);

    let variantSourceRefused = false;
    try {
      await ensureQuestionVariants(rows1[0].id, { target: 1, generate: scripted([[DISTINCT[5]]]) });
    } catch {
      variantSourceRefused = true;
    }
    check("variant of a variant refused", variantSourceRefused);
    const draft = await prisma.question.create({
      data: { code: `ZZVAR ${suffix} DRAFT`, examId: exam.id, subjectId: subject.id, text: "Draft?", status: "DRAFT", options: { create: SOURCE.options.map((o, order) => ({ ...o, order })) } },
    });
    let draftRefused = false;
    try {
      await ensureQuestionVariants(draft.id, { target: 1, generate: scripted([[DISTINCT[5]]]) });
    } catch {
      draftRefused = true;
    }
    check("unpublished source refused", draftRefused);
  } finally {
    console.log("\nCleaning up fixture data...");
    const ids = (await prisma.question.findMany({ where: { examId: exam.id }, select: { id: true } })).map((r) => r.id);
    await prisma.question.updateMany({ where: { id: { in: ids } }, data: { parentQuestionId: null } });
    await prisma.question.deleteMany({ where: { id: { in: ids } } });
    await prisma.topic.deleteMany({ where: { subjectId: subject.id } });
    await prisma.subject.delete({ where: { id: subject.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }
}

async function main() {
  console.log("=== AI Question Variants Verification ===\n");
  part1();
  if (!process.argv.includes("--pure")) await part2();
  console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
