import { prisma } from "@/lib/prisma";
import { resolveVerify2Disagreement } from "@/lib/ai-import/review";
const J = "cmwoezrtp00wt8dkz0olhkbo2", A = "cmud0ba2n00j4wukzcpsb6ode";
const W: Record<number, string> = {
  2: "Compared with page 2: stored stem, three statements and options (1 only / 1, 2 and 3 / 2 and 3 only / 1 and 3 only) match the print; the second read dropped words and changed options.",
  4: "Compared with page 2: stored four statements and options match the print; the second read invented an Assertion/Reason format.",
  5: "Compared with page 2: stored match codes 1 2 3 / 1 3 2 / 2 1 3 / 3 2 1 match the print; the second read returned statement-style options.",
  51: "Compared with page 11: stored stem and statements (incl. 'M-cells', 'L-cells') match the print; the second read changed statement 2 and dropped 'L-cells'.",
};
void (async () => {
  for (const [n, why] of Object.entries(W)) {
    const q = await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: J, sourceNumber: Number(n) } });
    await resolveVerify2Disagreement(q.id, A, why);
  }
  const left = await prisma.aiImportQuestion.findMany({ where: { jobId: J, issueCodes: { has: "VERIFY2_DISAGREES" } }, select: { sourceNumber: true } });
  console.log("open V2 flags:", left.map((q) => q.sourceNumber));
})().finally(() => prisma.$disconnect());
