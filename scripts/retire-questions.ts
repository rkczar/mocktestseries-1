/**
 * Retire questions in bulk through the SAME engine as Admin → Retire / Replace
 * (lib/question-replacement, docs/QUESTION-RETIREMENT.md). Production data
 * operation OP-3 (retire the archived RUHS MO 2016 questions) runs this.
 *
 *   # 1. dry run — writes nothing, prints exactly what would change and a plan hash
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts \
 *     --paper <paperId> --status ARCHIVED --reason "<why>" --dry-run
 *   # 2. apply — only with the hash printed by the dry run (refused if anything changed since)
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts \
 *     --paper <paperId> --status ARCHIVED --reason "<why>" --apply --confirm <hash>
 *   # rollback of one replacement record (dry run without --apply)
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts rollback --replacement <id> [--apply]
 *
 * Selection: --paper <id> (questions linked to that paper) and/or --ids a,b,c;
 * --status narrows by current status (e.g. ARCHIVED). Already-retired
 * questions are never selected. Options: --json <file> writes the full plan.
 */
import "dotenv/config";
import fs from "node:fs";
import { QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildReplacementPlan, summarizePlan } from "@/lib/question-replacement/plan";
import { applyReplacement, ReplacementError } from "@/lib/question-replacement/apply";
import { rollbackReplacement } from "@/lib/question-replacement/rollback";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function rollback() {
  const id = arg("replacement");
  if (!id) throw new Error("--replacement <id> is required");
  const rec = await prisma.questionReplacement.findUnique({
    where: { id },
    include: { _count: { select: { items: true, references: true } } },
  });
  if (!rec) throw new Error(`No replacement record ${id}`);
  const attempts = await prisma.testAttempt.count({ where: { invalidatedByReplacementId: id } });
  const answers = await prisma.answer.count({ where: { statsExcludedByReplacementId: id } });
  console.log(
    JSON.stringify(
      { replacement: id, kind: rec.kind, status: rec.status, createdAt: rec.createdAt, items: rec._count.items, references: rec._count.references, attemptsToRestore: attempts, answersToRestore: answers },
      null,
      2
    )
  );
  if (!flag("apply")) {
    console.log("DRY RUN — nothing changed. Re-run with --apply to roll back.");
    return;
  }
  const result = await rollbackReplacement(id, { adminId: null, source: "SCRIPT" });
  console.log("ROLLED BACK", JSON.stringify(result, null, 2));
}

async function retire() {
  const paperId = arg("paper");
  const ids = (arg("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const status = arg("status") as QuestionStatus | null;
  const reason = arg("reason") ?? "";
  if (!paperId && ids.length === 0) throw new Error("Give --paper <id> and/or --ids a,b,c");
  if (status && !Object.values(QuestionStatus).includes(status)) throw new Error(`--status must be one of ${Object.values(QuestionStatus).join(", ")}`);
  if (!flag("dry-run") && !flag("apply")) throw new Error("Choose --dry-run or --apply");

  const selected = await prisma.question.findMany({
    where: {
      retiredAt: null,
      parentQuestionId: null,
      ...(status ? { status } : {}),
      OR: [...(paperId ? [{ previousYearPaperId: paperId }] : []), ...(ids.length ? [{ id: { in: ids } }] : [])],
    },
    orderBy: [{ paperQuestionNumber: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { code: "asc" }],
    select: { id: true, code: true },
  });
  if (selected.length === 0) {
    console.log("Nothing selected (already retired, or no match).");
    return;
  }
  const pairs = selected.map((q) => ({ oldQuestionId: q.id, newQuestionId: null }));
  const plan = await buildReplacementPlan(prisma, pairs);
  const summary = summarizePlan(plan);
  const byContainer = new Map<string, { kind: string; title: string; studentOwned: boolean; actions: Record<string, number> }>();
  for (const r of plan.references) {
    const key = `${r.containerKind}:${r.containerId}`;
    const c = byContainer.get(key) ?? { kind: r.containerKind, title: r.containerTitle, studentOwned: r.studentOwned, actions: {} };
    c.actions[r.action] = (c.actions[r.action] ?? 0) + 1;
    byContainer.set(key, c);
  }
  console.log(`Selected ${selected.length} question(s): ${selected[0].code} … ${selected[selected.length - 1].code}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Containers changed: ${byContainer.size}`);
  for (const [key, c] of [...byContainer.entries()].slice(0, 400)) {
    console.log(`  ${c.kind}${c.studentOwned ? "(student)" : ""} ${key.split(":")[1]} "${c.title}" ${JSON.stringify(c.actions)}`);
  }
  if (plan.errors.length) console.log("ERRORS (apply would be refused):\n  " + plan.errors.join("\n  "));
  const out = arg("json");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ selected, summary, plan }, null, 1));
    console.log(`Full plan written to ${out}`);
  }
  console.log(`PLAN HASH ${plan.hash}`);

  if (flag("dry-run")) {
    console.log("DRY RUN — nothing changed.");
    return;
  }
  if (reason.trim().length < 3) throw new Error('--reason "<why>" is required to apply');
  const confirm = arg("confirm");
  if (confirm !== plan.hash) throw new Error(`--confirm must be the plan hash from the dry run (${plan.hash}); refusing.`);
  const result = await applyReplacement({ pairs, reason, actor: { adminId: null, source: "SCRIPT" }, expectedHash: confirm });
  console.log("APPLIED", JSON.stringify({ replacementId: result.replacementId, attemptsInvalidated: result.attemptsInvalidated, answersExcluded: result.answersExcluded }, null, 2));
  console.log(`Rollback: NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts rollback --replacement ${result.replacementId} --apply`);
}

async function main() {
  if (process.argv[2] === "rollback") await rollback();
  else await retire();
}

main()
  .catch((e) => {
    if (e instanceof ReplacementError) console.error(`REFUSED: ${e.message}${e.details.length ? `\n  ${e.details.join("\n  ")}` : ""}`);
    else console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
