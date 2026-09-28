/**
 * Repairs Previous Year Paper links that a Mock Test bulk import INFERRED
 * for another exam's questions (the bug fixed in lib/bulk-import.ts
 * resolveRow): a Haryana / Punjab / RPSC Dermatology PYQ file imported into
 * a RUHS mock had its rows saved under the mock's exam and then linked to
 * that exam's paper of the same year ("Source = PYQ" + year), inflating
 * e.g. RUHS MO 2024 from 100 to 443 questions.
 *
 * A link is repaired ONLY when the stored import provenance proves it wrong:
 *   1. the question was CREATED by a bulk-import row (status SUCCESS) of a
 *      run that targeted a Mock Test and had NO explicitly chosen paper
 *      (so the paper was inferred from exam + year, never chosen), and
 *   2. that row's own Exam column names a different exam than the paper's
 *      exam (compared on normalized name AND code — "RUHS MO" matches RUHS's
 *      code "RUHSMO"; "Haryana MO", "BFUHS MO", "PPSC MO",
 *      "RPSC AP Dermatology 2024" do not).
 * Links satisfying 1 but not 2 are reported as AMBIGUOUS and left untouched.
 *
 * The repair clears previousYearPaperId, sets source = QUESTION_BANK and
 * flags reviewRequired with the provenance. It NEVER deletes a question and
 * never touches examId, code, content, options, Mock Test membership,
 * TestAttempt / TestAttemptQuestion snapshots or answers. Before-state is
 * written to a JSON file and an AuditLog row.
 *
 *   npx tsx scripts/repair-mock-import-pyq-links.ts                # dry run (report only)
 *   npx tsx scripts/repair-mock-import-pyq-links.ts --apply --out <before-state.json>
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { QuestionSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const apply = process.argv.includes("--apply");
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function main() {
  if (apply && !outPath) throw new Error("--apply requires --out <before-state.json>");

  const linked = await prisma.question.findMany({
    where: {
      previousYearPaperId: { not: null },
      importBatch: { mockTestId: { not: null }, previousYearPaperId: null },
    },
    select: {
      id: true,
      code: true,
      text: true,
      status: true,
      source: true,
      examId: true,
      examYear: true,
      previousYearPaperId: true,
      reviewRequired: true,
      reviewReason: true,
      previousYearPaper: { select: { title: true, exam: { select: { name: true, code: true } } } },
      importBatch: { select: { id: true, label: true, filename: true, mockTest: { select: { title: true } } } },
      _count: { select: { mockTestQuestions: true } },
    },
    orderBy: { code: "asc" },
  });

  const provenRows = await prisma.bulkImportRow.findMany({
    where: { questionId: { in: linked.map((q) => q.id) }, status: "SUCCESS" },
    select: { questionId: true, runId: true, rowNumber: true, rawData: true },
  });
  const rowFor = new Map(provenRows.map((r) => [`${r.runId}:${r.questionId}`, r]));

  const proven: (typeof linked[number] & { fileExam: string; fileYear: string; rowNumber: number })[] = [];
  const ambiguous: { code: string; paper: string; reason: string }[] = [];
  for (const q of linked) {
    const row = rowFor.get(`${q.importBatch!.id}:${q.id}`);
    const raw = (row?.rawData ?? {}) as Record<string, unknown>;
    const fileExam = typeof raw.exam === "string" ? raw.exam.trim() : "";
    const paperExam = q.previousYearPaper!.exam;
    if (!row) {
      ambiguous.push({ code: q.code, paper: q.previousYearPaper!.title, reason: "no SUCCESS import row created this question" });
    } else if (!fileExam) {
      ambiguous.push({ code: q.code, paper: q.previousYearPaper!.title, reason: "file row has no Exam column value" });
    } else if (norm(fileExam) === norm(paperExam.code) || norm(fileExam) === norm(paperExam.name)) {
      ambiguous.push({ code: q.code, paper: q.previousYearPaper!.title, reason: `file Exam "${fileExam}" matches the paper's exam` });
    } else {
      proven.push({ ...q, fileExam, fileYear: String(raw.examYear ?? ""), rowNumber: row.rowNumber });
    }
  }

  // Exact-text twin in another exam — informational (owner review), never acted on.
  const twins = await prisma.question.findMany({
    where: { text: { in: proven.map((q) => q.text) }, NOT: { id: { in: proven.map((q) => q.id) } } },
    select: { code: true, text: true, examId: true, previousYearPaper: { select: { title: true } } },
  });
  const twinFor = new Map<string, string[]>();
  for (const t of twins) twinFor.set(t.text, [...(twinFor.get(t.text) ?? []), `${t.code}${t.previousYearPaper ? ` (${t.previousYearPaper.title})` : ""}`]);

  const groups = new Map<string, typeof proven>();
  for (const q of proven) {
    const key = `${q.previousYearPaper!.title} ← ${q.importBatch!.filename} [mock: ${q.importBatch!.mockTest?.title ?? "—"}] file exam "${q.fileExam}" ${q.fileYear}`;
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Mock-import-inferred PYQ links: ${linked.length}  proven wrong: ${proven.length}  ambiguous: ${ambiguous.length}`);
  for (const [key, qs] of groups) {
    const withTwin = qs.filter((q) => twinFor.has(q.text)).length;
    console.log(`  ${qs.length.toString().padStart(4)}  ${key}  codes ${qs[0].code} … ${qs[qs.length - 1].code}  (exact-text twin elsewhere: ${withTwin})`);
  }
  for (const a of ambiguous) console.log(`  AMBIGUOUS ${a.code} (${a.paper}): ${a.reason}`);

  if (!apply || proven.length === 0) return;

  const before = proven.map((q) => ({
    id: q.id,
    code: q.code,
    previousYearPaperId: q.previousYearPaperId,
    paperTitle: q.previousYearPaper!.title,
    source: q.source,
    reviewRequired: q.reviewRequired,
    reviewReason: q.reviewReason,
    importRunId: q.importBatch!.id,
    importRowNumber: q.rowNumber,
    fileExam: q.fileExam,
    fileYear: q.fileYear,
    exactTextTwins: twinFor.get(q.text) ?? [],
  }));
  writeFileSync(outPath!, JSON.stringify({ at: new Date().toISOString(), count: before.length, questions: before }, null, 2), { mode: 0o600 });

  await prisma.$transaction(
    async (tx) => {
      for (const q of proven) {
        const twin = twinFor.get(q.text)?.[0];
        await tx.question.update({
          where: { id: q.id },
          data: {
            previousYearPaperId: null,
            source: QuestionSource.QUESTION_BANK,
            reviewRequired: true,
            reviewReason: `PYQ link to "${q.previousYearPaper!.title}" removed: imported from a "${q.fileExam} ${q.fileYear}" file into mock "${
              q.importBatch!.mockTest?.title ?? "—"
            }", not an original paper question.${twin ? ` Same text as ${twin}.` : ""}`.slice(0, 1000),
          },
        });
      }
      await tx.auditLog.create({
        data: {
          action: "PYQ_MOCK_IMPORT_LINKS_REPAIRED",
          entityType: "Question",
          metadata: { count: proven.length, beforeStateFile: outPath, byPaper: Object.fromEntries([...groups].map(([k, v]) => [k, v.length])) },
        },
      });
    },
    { timeout: 120_000 }
  );
  console.log(`Repaired ${proven.length} question(s). Before-state: ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
