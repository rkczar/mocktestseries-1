import "server-only";

import { prisma } from "@/lib/db";

import { examShortCode } from "./shortCode";
import type { ParsedRow, RowOutcome } from "./validateRows";

export type DuplicatePolicy = "skip" | "replace" | "add_anyway";

async function nextSequence(examId: string, shortCode: string, year: number, cache: Map<number, number>) {
  if (!cache.has(year)) {
    const prefix = `${shortCode}-${year}-Q`;
    const rows = await prisma.question.findMany({
      where: { examId, code: { startsWith: prefix } },
      select: { code: true },
    });
    let max = 0;
    for (const row of rows) {
      const match = row.code.slice(prefix.length).match(/^(\d+)/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    cache.set(year, max);
  }
  const next = cache.get(year)! + 1;
  cache.set(year, next);
  return `${shortCode}-${year}-Q${String(next).padStart(4, "0")}`;
}

function uniqueSuffix(baseCode: string, usedCodes: Set<string>) {
  if (!usedCodes.has(baseCode)) {
    usedCodes.add(baseCode);
    return baseCode;
  }
  let n = 1;
  let candidate = `${baseCode}-DUP${n}`;
  while (usedCodes.has(candidate)) {
    n += 1;
    candidate = `${baseCode}-DUP${n}`;
  }
  usedCodes.add(candidate);
  return candidate;
}

export async function applyImport({
  examId,
  examSlug,
  outcomes,
  duplicatePolicy,
  adminId,
  fileName,
  fileHash,
}: {
  examId: string;
  examSlug: string;
  outcomes: RowOutcome[];
  duplicatePolicy: DuplicatePolicy;
  adminId: string;
  fileName: string;
  fileHash: string;
}) {
  const shortCode = examShortCode(examSlug);
  const sequenceCache = new Map<number, number>();
  const subjectCache = new Map<string, string>();
  const usedCodes = new Set(
    (await prisma.question.findMany({ select: { code: true } })).map((q) => q.code),
  );

  async function resolveSubjectId(name: string) {
    const cached = subjectCache.get(name);
    if (cached) return cached;
    const subject = await prisma.subject.upsert({
      where: { examId_name: { examId, name } },
      update: {},
      create: { examId, name },
    });
    subjectCache.set(name, subject.id);
    return subject.id;
  }

  async function createFromRow(data: ParsedRow, code: string, questionNumber: number | null) {
    const subjectId = await resolveSubjectId(data.subject);
    await prisma.question.create({
      data: {
        examId,
        code,
        paperYear: data.paperYear,
        questionNumber,
        subjectId,
        topic: data.topic,
        subTopic: data.subTopic,
        stem: data.stem,
        optionA: data.optionA,
        optionB: data.optionB,
        optionC: data.optionC,
        optionD: data.optionD,
        correctAnswer: data.correctAnswer,
        explanation: data.explanation,
        source: data.source,
        difficulty: data.difficulty,
        status: data.status,
        createdById: adminId,
      },
    });
  }

  let imported = 0;
  let replaced = 0;
  let addedAnyway = 0;
  let skipped = 0;
  let invalid = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === "invalid") {
      invalid += 1;
      continue;
    }

    if (outcome.kind === "valid") {
      const code = outcome.data.code
        ? uniqueSuffix(outcome.data.code, usedCodes)
        : await nextSequence(examId, shortCode, outcome.data.paperYear, sequenceCache).then((c) =>
            uniqueSuffix(c, usedCodes),
          );
      await createFromRow(outcome.data, code, outcome.data.questionNumber);
      imported += 1;
      continue;
    }

    // duplicate
    if (duplicatePolicy === "skip") {
      skipped += 1;
      continue;
    }

    if (duplicatePolicy === "replace" && (outcome.matchedQuestionId || outcome.data.code)) {
      const subjectId = await resolveSubjectId(outcome.data.subject);
      const data = outcome.data;
      const updateData = {
        paperYear: data.paperYear,
        questionNumber: data.questionNumber,
        subjectId,
        topic: data.topic,
        subTopic: data.subTopic,
        stem: data.stem,
        optionA: data.optionA,
        optionB: data.optionB,
        optionC: data.optionC,
        optionD: data.optionD,
        correctAnswer: data.correctAnswer,
        explanation: data.explanation,
        source: data.source,
        difficulty: data.difficulty,
        status: data.status,
      };
      if (outcome.matchedQuestionId) {
        await prisma.question.update({ where: { id: outcome.matchedQuestionId }, data: updateData });
      } else if (data.code) {
        await prisma.question.update({ where: { code: data.code }, data: updateData });
      }
      replaced += 1;
      continue;
    }

    // add_anyway (or replace with no resolvable existing match, e.g. within-file dup). The
    // original row already holds this exam+year+questionNumber slot, so the extra copy is
    // created without one rather than violating the unique constraint.
    const baseCode =
      outcome.data.code ?? (await nextSequence(examId, shortCode, outcome.data.paperYear, sequenceCache));
    const code = uniqueSuffix(baseCode, usedCodes);
    await createFromRow(outcome.data, code, null);
    addedAnyway += 1;
  }

  const batch = await prisma.importBatch.create({
    data: {
      examId,
      fileName,
      fileHash,
      totalRows: outcomes.length,
      importedCount: imported,
      replacedCount: replaced,
      addedAnywayCount: addedAnyway,
      skippedCount: skipped,
      invalidCount: invalid,
      createdById: adminId,
    },
  });

  return { batch, imported, replaced, addedAnyway, skipped, invalid };
}
