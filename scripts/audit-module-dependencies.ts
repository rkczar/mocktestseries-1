/**
 * READ-ONLY audit of student-created Custom Modules that hold an exam's PYQ
 * questions (production data operation OP-1, docs/QUESTION-RETIREMENT.md).
 * Runs inside a READ ONLY transaction: it cannot write to the database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-module-dependencies.ts --exam RUHSMO --out /root/mts-evidence/phase1
 *
 * Writes <out>/module-audit-<exam>-<timestamp>.{csv,json,md}. No student names
 * or contact details: modules are listed by id and title only, owners only as
 * a distinct count.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

type ModuleRow = {
  moduleId: string;
  title: string;
  status: string;
  studentOwned: boolean;
  createdAt: Date;
  questions: number;
  servable: number;
  archivedNotRetired: number;
  retired: number;
  pyqQuestions: number;
  pyqByYear: Record<string, number> | null;
  attemptsSubmitted: number;
  attemptsInProgress: number;
  attemptsInvalidated: number;
};

async function main() {
  const examCode = arg("exam");
  const outDir = arg("out");
  if (!examCode || !outDir) throw new Error("--exam <code> and --out <dir> are required");
  const exam = await prisma.exam.findUnique({ where: { code: examCode }, select: { id: true, name: true, code: true } });
  if (!exam) throw new Error(`No exam with code ${examCode}`);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const papers = await tx.previousYearPaper.findMany({ where: { examId: exam.id }, orderBy: { year: "asc" }, select: { id: true, year: true, title: true } });
    const paperIds = papers.map((p) => p.id);
    const modules = await tx.$queryRaw<ModuleRow[]>`
      WITH target AS (
        SELECT DISTINCT cq."customModuleId" AS id
        FROM "CustomModuleQuestion" cq JOIN "Question" q ON q.id = cq."questionId"
        WHERE q."previousYearPaperId" = ANY(${paperIds}::text[])
      ),
      qstats AS (
        SELECT cq."customModuleId" AS id,
               COUNT(*)::int AS questions,
               COUNT(*) FILTER (WHERE q.status = 'PUBLISHED' AND q."retiredAt" IS NULL)::int AS servable,
               COUNT(*) FILTER (WHERE q.status = 'ARCHIVED' AND q."retiredAt" IS NULL)::int AS "archivedNotRetired",
               COUNT(*) FILTER (WHERE q."retiredAt" IS NOT NULL)::int AS retired,
               COUNT(*) FILTER (WHERE q."previousYearPaperId" = ANY(${paperIds}::text[]))::int AS "pyqQuestions"
        FROM "CustomModuleQuestion" cq JOIN "Question" q ON q.id = cq."questionId"
        WHERE cq."customModuleId" IN (SELECT id FROM target)
        GROUP BY 1
      ),
      years AS (
        SELECT y.id, jsonb_object_agg(y.year, y.n) AS "pyqByYear"
        FROM (
          SELECT cq."customModuleId" AS id, p.year::text AS year, COUNT(*)::int AS n
          FROM "CustomModuleQuestion" cq JOIN "Question" q ON q.id = cq."questionId" JOIN "PreviousYearPaper" p ON p.id = q."previousYearPaperId"
          WHERE cq."customModuleId" IN (SELECT id FROM target) AND p.id = ANY(${paperIds}::text[])
          GROUP BY 1, 2
        ) y GROUP BY y.id
      ),
      att AS (
        SELECT a."customModuleId" AS id,
               COUNT(*) FILTER (WHERE a.status = 'SUBMITTED')::int AS "attemptsSubmitted",
               COUNT(*) FILTER (WHERE a.status = 'IN_PROGRESS')::int AS "attemptsInProgress",
               COUNT(*) FILTER (WHERE a."invalidatedAt" IS NOT NULL)::int AS "attemptsInvalidated"
        FROM "TestAttempt" a WHERE a."customModuleId" IN (SELECT id FROM target) GROUP BY 1
      )
      SELECT cm.id AS "moduleId", cm.title, cm.status::text AS status, cm."isStudentOwned" AS "studentOwned", cm."createdAt",
             qs.questions, qs.servable, qs."archivedNotRetired", qs.retired, qs."pyqQuestions", y."pyqByYear",
             COALESCE(att."attemptsSubmitted", 0) AS "attemptsSubmitted",
             COALESCE(att."attemptsInProgress", 0) AS "attemptsInProgress",
             COALESCE(att."attemptsInvalidated", 0) AS "attemptsInvalidated"
      FROM "CustomModule" cm
      JOIN qstats qs ON qs.id = cm.id
      LEFT JOIN years y ON y.id = cm.id
      LEFT JOIN att ON att.id = cm.id
      ORDER BY cm."isStudentOwned" DESC, cm."createdAt"`;
    const owners = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT cm."createdByStudentId")::int AS n FROM "CustomModule" cm
      WHERE cm."isStudentOwned" AND cm.id = ANY(${modules.map((m) => m.moduleId)}::text[])`;
    return { papers, modules, owners: owners[0]?.n ?? 0 };
  });

  const student = result.modules.filter((m) => m.studentOwned);
  const affected = student.filter((m) => m.archivedNotRetired + m.retired > 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    exam: { code: exam.code, name: exam.name },
    papers: result.papers.map((p) => ({ id: p.id, year: p.year, title: p.title })),
    modules: {
      total: result.modules.length,
      studentOwned: student.length,
      adminOwned: result.modules.length - student.length,
      byStatus: Object.fromEntries([...new Set(result.modules.map((m) => m.status))].map((s) => [s, result.modules.filter((m) => m.status === s).length])),
      studentOwners: result.owners,
    },
    studentModulesHoldingArchivedOrRetired: {
      modules: affected.length,
      slots: affected.reduce((a, m) => a + m.archivedNotRetired + m.retired, 0),
      attemptsSubmitted: affected.reduce((a, m) => a + m.attemptsSubmitted, 0),
      attemptsInProgress: affected.reduce((a, m) => a + m.attemptsInProgress, 0),
      modulesThatWouldBeEmpty: affected.filter((m) => m.servable === 0).length,
    },
    pyqSlotsByYear: result.modules.reduce<Record<string, number>>((acc, m) => {
      for (const [y, n] of Object.entries(m.pyqByYear ?? {})) acc[y] = (acc[y] ?? 0) + n;
      return acc;
    }, {}),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const base = path.join(outDir, `module-audit-${exam.code}-${stamp}`);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = ["moduleId", "title", "status", "studentOwned", "createdAt", "questions", "servable", "archivedNotRetired", "retired", "pyqQuestions", "pyqByYear", "attemptsSubmitted", "attemptsInProgress", "attemptsInvalidated"] as const;
  fs.writeFileSync(`${base}.csv`, [cols.join(","), ...result.modules.map((m) => cols.map((c) => esc(c === "createdAt" ? m.createdAt.toISOString() : m[c])).join(","))].join("\n") + "\n");
  fs.writeFileSync(`${base}.json`, JSON.stringify({ summary, modules: result.modules }, null, 1));
  fs.writeFileSync(
    `${base}.md`,
    [
      `# Module dependency audit — ${exam.name} (${exam.code})`,
      ``,
      `Generated ${summary.generatedAt} (read-only transaction).`,
      ``,
      `- Modules holding this exam's PYQ questions: **${summary.modules.total}** (${summary.modules.studentOwned} student-created by ${summary.modules.studentOwners} students, ${summary.modules.adminOwned} admin).`,
      `- Status: ${Object.entries(summary.modules.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
      `- Student modules holding archived or retired questions: **${summary.studentModulesHoldingArchivedOrRetired.modules}** (${summary.studentModulesHoldingArchivedOrRetired.slots} slots; ${summary.studentModulesHoldingArchivedOrRetired.attemptsSubmitted} submitted / ${summary.studentModulesHoldingArchivedOrRetired.attemptsInProgress} in-progress attempts; ${summary.studentModulesHoldingArchivedOrRetired.modulesThatWouldBeEmpty} would have no servable question left).`,
      `- PYQ slots by paper year: ${Object.entries(summary.pyqSlotsByYear).map(([y, n]) => `${y}: ${n}`).join(", ")}.`,
      ``,
      `Per-module rows: ${path.basename(base)}.csv`,
    ].join("\n") + "\n"
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${base}.{csv,json,md}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
