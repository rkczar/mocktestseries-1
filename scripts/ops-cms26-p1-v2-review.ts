/**
 * After the page-limited Verify 2 (2026-11-20, job cmwoezrtp00wt8dkz0olhkbo2), each disagreement compared with the page
 * image (evidence /root/mts-evidence/key-integrity-deploy/pages):
 *   Q39/Q41/Q113: stored text = printed page; the second read was wrong → audited resolution (never an approval).
 *   Q43: options = printed page; the stem had an OCR artifact ("一") and missing dashes → corrected from page 9.
 *   ACTOR=<admin id> [--apply --confirm=cmwoezrtp00wt8dkz0olhkbo2]
 */
import { prisma } from "@/lib/prisma";
import { editQuestion, resolveVerify2Disagreement } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";

const J = "cmwoezrtp00wt8dkz0olhkbo2";
const ACTOR = process.env.ACTOR ?? "";
const apply = process.argv.includes("--apply") && process.argv.includes(`--confirm=${J}`);
const RESOLVE: Record<number, string> = {
  39: "Checked page 9: stored stem and options match the printed question word for word; the second read differs only in curly vs straight apostrophes.",
  41: "Checked page 9: stored stem (four statements) and options (1, 2 and 4 / 2, 3 and 4 / 2 and 4 only / 1 and 3) match the print; the second read put the statements in place of the options.",
  113: "Checked page 23: option (c) is printed '6 weeks, 10 weeks and 9 months' as stored; the second read's '12 weeks' is wrong.",
};
const Q43_STEM = "Consider the following pairs with respect to muscle channelopathies :\n(Channel) – (Muscle disease)\n1. Sodium – Paramyotonia congenita\n2. Calcium – Malignant hyperthermia\n3. Ryanodine receptor – Becker disease\n4. Chloride – Thomsen disease\nWhich of the pairs given above are correctly matched ?";

void (async () => {
  if (!ACTOR) throw new Error("set ACTOR");
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId: J, sourceNumber: { in: [39, 41, 43, 113] } } });
  const by = (n: number) => qs.find((q) => q.sourceNumber === n)!;
  const v2 = (n: number) => (effective(by(n)) as { paperVerify?: { v2?: { status?: string } } }).paperVerify?.v2?.status;
  const e43 = effective(by(43));
  const pre = { v2: [39, 41, 43, 113].map((n) => `${n}:${v2(n)}`), q43opts: e43.options.map((o) => o.text.replace(/\s/g, "")).join("|") === "1,2,3and4|1,3and4only|1,2and4only|2and3only", q43artifact: e43.stem.includes("一") };
  console.log("preconditions", pre);
  if (!pre.q43opts || !pre.q43artifact || [39, 41, 113].some((n) => v2(n) !== "DISAGREE")) throw new Error("precondition failed — nothing changed");
  if (!apply) return console.log("DRY RUN — nothing changed.");
  for (const [n, why] of Object.entries(RESOLVE)) await resolveVerify2Disagreement(by(Number(n)).id, ACTOR, why);
  await editQuestion(by(43).id, ACTOR, { stem: Q43_STEM, options: e43.options.map((o) => ({ label: o.label, text: o.text })), type: e43.type, contentFormat: (e43.contentFormat ?? "PLAIN") as "PLAIN" | "RICH_V1" }, { note: "checked against page 9: OCR artifact and missing dashes in the pairs list" });
  console.log("APPLIED");
})()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
