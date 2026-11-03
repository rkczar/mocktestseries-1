/**
 * Backfill Question.paperQuestionNumber (production data operation OP-2,
 * docs/QUESTION-RETIREMENT.md). The PYQ attempt orders by this number, then by
 * today's order (createdAt, code), so a paper with no numbers is unchanged.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --dry-run [--paper <id>] [--json <file>]
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --apply --confirm <hash> [--paper <id>]
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --revert [--apply]
 *
 * Per paper (every linked question, any status):
 *  - IMPORT: every question has a printed number from its import (the AI
 *    Importer's sourceNumber when the question was not in a numbered section,
 *    else the Bulk Import row's questionNumber) and the numbers are unique → use them;
 *  - ORDER: otherwise number 1..n in today's order (createdAt, code) — the
 *    order students already see, so nothing moves.
 * Papers where any question already has a number are skipped (reported).
 * --apply needs the hash printed by --dry-run. Writes one AuditLog row with
 * every (id, number) pair; --revert sets exactly those back to NULL.
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const AUDIT = "PAPER_QUESTION_NUMBERS_BACKFILLED";
const AUDIT_REVERT = "PAPER_QUESTION_NUMBERS_REVERTED";

interface PaperPlan {
  paperId: string;
  title: string;
  year: number;
  questions: number;
  decision: "IMPORT" | "ORDER" | "SKIP_ALREADY_NUMBERED";
  /** Positions (1-based, today's order) whose question moves under the IMPORT numbers. */
  moved: number;
  missing: number;
  duplicates: number;
  assignments: [string, number][];
}

async function planPapers(paperFilter: string | null): Promise<PaperPlan[]> {
  const papers = await prisma.previousYearPaper.findMany({
    where: paperFilter ? { id: paperFilter } : {},
    orderBy: [{ examId: "asc" }, { year: "asc" }],
    select: { id: true, title: true, year: true },
  });
  const plans: PaperPlan[] = [];
  for (const p of papers) {
    const qs = await prisma.question.findMany({
      where: { previousYearPaperId: p.id },
      orderBy: [{ createdAt: "asc" }, { code: "asc" }],
      select: { id: true, paperQuestionNumber: true },
    });
    if (qs.length === 0) continue;
    const base = { paperId: p.id, title: p.title, year: p.year, questions: qs.length, moved: 0, missing: 0, duplicates: 0, assignments: [] as [string, number][] };
    if (qs.some((q) => q.paperQuestionNumber !== null)) {
      plans.push({ ...base, decision: "SKIP_ALREADY_NUMBERED" });
      continue;
    }
    const ids = qs.map((q) => q.id);
    const [ai, bulk] = await Promise.all([
      // sourceKey "#38" = no section (a numbered section restarts at 1: "S2#1").
      prisma.aiImportQuestion.findMany({
        where: { questionId: { in: ids }, sourceNumber: { not: null }, sourceKey: { startsWith: "#" } },
        orderBy: { updatedAt: "asc" },
        select: { questionId: true, sourceNumber: true },
      }),
      prisma.$queryRaw<{ questionId: string; n: string }[]>`
        SELECT DISTINCT ON (r."questionId") r."questionId", r."rawData"->>'questionNumber' AS n
        FROM "BulkImportRow" r
        WHERE r."questionId" = ANY(${ids}::text[]) AND r.status IN ('SUCCESS', 'REPLACED') AND r."removedFromImport" = false
          AND (r."rawData"->>'questionNumber') ~ '^[0-9]{1,4}$'
        ORDER BY r."questionId", r."createdAt" DESC`,
    ]);
    const num = new Map<string, number>();
    for (const b of bulk) num.set(b.questionId, Number(b.n));
    // AI numbers win over Bulk Import rows (the importer read the printed paper).
    for (const a of ai) if (a.questionId && a.sourceNumber !== null) num.set(a.questionId, a.sourceNumber);
    const values = ids.map((id) => num.get(id));
    const missing = values.filter((v) => v === undefined || v < 1).length;
    const seen = new Map<number, number>();
    for (const v of values) if (v !== undefined) seen.set(v, (seen.get(v) ?? 0) + 1);
    const duplicates = [...seen.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0);
    if (missing === 0 && duplicates === 0) {
      const sorted = [...ids].sort((x, y) => num.get(x)! - num.get(y)!);
      const moved = sorted.filter((id, i) => ids[i] !== id).length;
      plans.push({ ...base, decision: "IMPORT", moved, assignments: ids.map((id) => [id, num.get(id)!]) });
    } else {
      plans.push({ ...base, decision: "ORDER", missing, duplicates, assignments: ids.map((id, i) => [id, i + 1]) });
    }
  }
  return plans;
}

function hashOf(plans: PaperPlan[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(plans.map((p) => [p.paperId, p.decision, p.assignments])))
    .digest("hex")
    .slice(0, 16);
}

async function revert() {
  const runs = await prisma.auditLog.findMany({ where: { action: AUDIT }, orderBy: { createdAt: "desc" } });
  const reverted = new Set(
    (await prisma.auditLog.findMany({ where: { action: AUDIT_REVERT }, select: { entityId: true } })).map((r) => r.entityId)
  );
  const pending = runs.filter((r) => !reverted.has(r.id));
  const pairs = pending.flatMap((r) => ((r.metadata as { assignments?: [string, number][] } | null)?.assignments ?? []));
  console.log(`Backfill runs to revert: ${pending.length}; numbers to clear: ${pairs.length}`);
  if (!flag("apply")) {
    console.log("DRY RUN — nothing changed. Re-run with --revert --apply.");
    return;
  }
  await prisma.$transaction(async (tx) => {
    let cleared = 0;
    for (const [id, n] of pairs) {
      cleared += (await tx.question.updateMany({ where: { id, paperQuestionNumber: n }, data: { paperQuestionNumber: null } })).count;
    }
    for (const r of pending) {
      await tx.auditLog.create({ data: { action: AUDIT_REVERT, entityType: "AuditLog", entityId: r.id, metadata: { cleared } } });
    }
    console.log(`REVERTED: ${cleared} number(s) cleared (a number changed since by a replacement is left as it is).`);
  }, { timeout: 300_000, maxWait: 30_000 });
}

async function main() {
  if (flag("revert")) return revert();
  if (!flag("dry-run") && !flag("apply")) throw new Error("Choose --dry-run, --apply --confirm <hash> or --revert");
  const plans = await planPapers(arg("paper"));
  const hash = hashOf(plans);
  const count = (d: PaperPlan["decision"]) => plans.filter((p) => p.decision === d);
  console.log(`Papers: ${plans.length} · IMPORT numbers ${count("IMPORT").length} · ORDER (today's order) ${count("ORDER").length} · skipped (already numbered) ${count("SKIP_ALREADY_NUMBERED").length}`);
  console.log(`Questions to number: ${plans.reduce((a, p) => a + p.assignments.length, 0)}`);
  for (const p of plans) {
    console.log(
      `  ${p.decision.padEnd(22)} ${p.paperId} ${p.year} "${p.title}" q=${p.questions}${p.decision === "IMPORT" ? ` order-changes=${p.moved}` : ""}${p.decision === "ORDER" ? ` missing=${p.missing} duplicate=${p.duplicates}` : ""}`
    );
  }
  const out = arg("json");
  if (out) fs.writeFileSync(out, JSON.stringify(plans, null, 1));
  console.log(`PLAN HASH ${hash}`);
  if (flag("dry-run")) {
    console.log("DRY RUN — nothing changed.");
    return;
  }
  if (arg("confirm") !== hash) throw new Error(`--confirm must be the plan hash from the dry run (${hash}); refusing.`);
  const assignments = plans.flatMap((p) => p.assignments);
  await prisma.$transaction(
    async (tx) => {
      let written = 0;
      for (const [id, n] of assignments) {
        written += (await tx.question.updateMany({ where: { id, paperQuestionNumber: null }, data: { paperQuestionNumber: n } })).count;
      }
      if (written !== assignments.length) throw new Error(`Expected ${assignments.length} rows, wrote ${written} — something changed; rolled back.`);
      await tx.auditLog.create({
        data: { action: AUDIT, entityType: "Question", entityId: null, metadata: { hash, papers: plans.length, assignments } },
      });
    },
    { timeout: 300_000, maxWait: 30_000 }
  );
  console.log(`APPLIED: ${assignments.length} question number(s) written. Revert: --revert --apply`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
