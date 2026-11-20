/**
 * Source-backed corrections for job cmwoezrtp00wt8dkz0olhkbo2 (CMS 2026 Paper I), 2026-11-20. Every change is checked
 * against the original page image (evidence /root/mts-evidence/key-integrity-deploy/pages) and goes through the audited
 * review functions (version + admin check + job event + AuditLog). Nothing is approved, imported, published or deleted;
 * no answer is set.
 *   Q3  (Question Bank cmwok2pyr019dn2kzl7ws1r6r): answer B came from the false key → answerVerification UNVERIFIED
 *       (publish now blocked), review reason; its import row loses the false official answer (answer kept as stored).
 *   Q51 (unnumbered row, page 11): number 51 + the printed opening "Consider the following statements regarding".
 *   Q38 (page 9): option (b) is "2" (stored empty).
 *   Q20 (page 6): the stored figure is a crop of the option text; replaced by the CT image crop.
 *   Then Verify 1 (free, no AI) for the job.
 *   ACTOR=<admin id> [--apply --confirm=cmwoezrtp00wt8dkz0olhkbo2]
 */
import { prisma } from "@/lib/prisma";
import { cropFigureFromPage, editQuestion, revalidateQuestions } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";
import { logEvent } from "@/lib/ai-import/jobs";
import { runVerify1 } from "@/lib/ai-import/paper-verify";

const J = "cmwoezrtp00wt8dkz0olhkbo2";
const QB3 = "cmwok2pyr019dn2kzl7ws1r6r";
const ACTOR = process.env.ACTOR ?? "";
const apply = process.argv.includes("--apply") && process.argv.includes(`--confirm=${J}`);
const one = async (where: object) => prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: J, ...where } });

void (async () => {
  if (!ACTOR) throw new Error("set ACTOR");
  const q3 = await one({ sourceNumber: 3 });
  const qb3 = await prisma.question.findUniqueOrThrow({ where: { id: QB3 }, select: { status: true, answerVerification: true, reviewReason: true } });
  const q51 = await one({ sourceNumber: null, pages: { has: 11 } });
  const q38 = await one({ sourceNumber: 38 });
  const q20 = await one({ sourceNumber: 20 });
  const fig20 = await prisma.aiImportFigure.findFirstOrThrow({ where: { questionId: q20.id } });
  const e51 = effective(q51), e38 = effective(q38);
  const checks = {
    q3: q3.questionId === QB3 && qb3.status === "DRAFT" && qb3.answerVerification === "OFFICIAL_KEY" && q3.answerStatus === "OFFICIAL_MATCHED",
    q51: /^glucagon-like peptide-1 \(GLP-1\)/.test(e51.stem.trim()) && e51.options.map((o) => o.text.replace(/\s/g, "")).join("|") === "1and2only|1,2and3|3and4only|2,3and4",
    q38: e38.options[1]?.label === "B" && !e38.options[1].text.trim() && e38.options.map((o) => o.text.trim()).join("|") === "1||3A|3B",
    q20: fig20.id === "cmwog7gbj004u20kz5nc4ac2d" && fig20.mappingStatus === "UNCERTAIN",
  };
  console.log("preconditions", checks);
  if (Object.values(checks).some((v) => !v)) throw new Error("a precondition failed — nothing changed");
  if (!apply) return console.log("DRY RUN — nothing changed.");

  // Q3: provenance only (status, text, options, correct option untouched).
  const reason = `Answer B came from a false answer key (CMS 2026 Paper II test booklet, import ${J}); re-verify against the genuine Paper I key before publishing.`;
  const r = await prisma.question.updateMany({ where: { id: QB3, status: "DRAFT", answerVerification: "OFFICIAL_KEY" }, data: { answerVerification: "UNVERIFIED", reviewRequired: true, reviewReason: `${reason} ${qb3.reviewReason ?? ""}`.trim().slice(0, 1000) } });
  if (r.count !== 1) throw new Error("Q3 changed meanwhile — stopped");
  await prisma.auditLog.create({ data: { actorId: ACTOR, action: "QUESTION_ANSWER_PROVENANCE_CORRECTED", entityType: "Question", entityId: QB3, metadata: { before: { answerVerification: "OFFICIAL_KEY", reviewReason: qb3.reviewReason }, after: { answerVerification: "UNVERIFIED" }, reason, falseKeyFile: "cmwof02ps00wy8dkzv8e6sbja", via: "scripts/ops-cms26-p1-corrections.ts" } } });
  await prisma.aiImportQuestion.update({ where: { id: q3.id }, data: { answerStatus: "UNVERIFIED", officialAnswer: [] } });
  await logEvent(J, "RECOVERY_FALSE_KEY", `Q3: the official answer B came from the false key — import row set to answer UNVERIFIED (answer kept as stored, not replaced); Question Bank ${QB3} stays DRAFT with answer UNVERIFIED (publishing blocked).`, { questionId: q3.id, before: { answerStatus: q3.answerStatus, officialAnswer: q3.officialAnswer } }, ACTOR);

  // Q51: number + the printed opening words (page 11).
  await editQuestion(q51.id, ACTOR, { stem: `Consider the following statements regarding ${e51.stem.trim()}`, options: e51.options.map((o) => ({ label: o.label, text: o.text })), type: e51.type, contentFormat: (e51.contentFormat ?? "PLAIN") as "PLAIN" | "RICH_V1", number: 51 }, { note: "checked against page 11 of the question paper: printed number 51 and opening words" });
  // editQuestion keeps the row's own number column; the printed number is set with it (same audit trail).
  await prisma.aiImportQuestion.update({ where: { id: q51.id }, data: { sourceNumber: 51, sourceLabel: "51" } });
  await logEvent(J, "QUESTION_EDITED", "Q51: printed number 51 recorded on the question row (was unnumbered)", { questionId: q51.id }, ACTOR);

  // Q38: option (b) "2" (page 9).
  await editQuestion(q38.id, ACTOR, { stem: e38.stem, options: e38.options.map((o) => ({ label: o.label, text: o.label === "B" ? "2" : o.text })), type: e38.type, contentFormat: (e38.contentFormat ?? "PLAIN") as "PLAIN" | "RICH_V1" }, { note: "checked against page 9 of the question paper: option (b) is 2" });

  // Q20: the CT image (page 6) replaces the wrong crop.
  await cropFigureFromPage({ questionId: q20.id, actorId: ACTOR, pageNumber: 6, box: { x: 0.158, y: 0.656, w: 0.288, h: 0.14 }, owner: "STEM", optionLabel: null, replaceFigureId: fig20.id });

  await revalidateQuestions(J, [q3.id, q51.id, q38.id, q20.id].filter((id) => id !== q3.id));
  const v1 = await runVerify1(J, ACTOR);
  console.log("APPLIED; Verify 1:", JSON.stringify(v1).slice(0, 400));
})()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
