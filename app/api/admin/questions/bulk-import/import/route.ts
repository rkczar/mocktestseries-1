import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { allocateQuestionCode, questionCodeScope } from "@/lib/question-code";
import { BulkImportDuplicateStrategy, BulkImportStatus, BulkImportRowStatus } from "@prisma/client";
import type { ValidatedImportRow } from "@/lib/bulk-import";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export async function POST(request: NextRequest) {
  let runId: string | undefined;

  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    const { rows, duplicateStrategy, filename } = body as {
      rows: ValidatedImportRow[];
      duplicateStrategy: BulkImportDuplicateStrategy;
      filename: string;
    };

    if (!rows || !Array.isArray(rows)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!["SKIP", "REPLACE", "ADD_AS_NEW"].includes(duplicateStrategy)) {
      return NextResponse.json({ error: "Invalid duplicate strategy" }, { status: 400 });
    }

    const validRows = rows.filter((r) => r.isValid && r.resolvedData);

    // Create import run
    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: session.user.id!,
        filename: filename || "unknown",
        totalRows: rows.length,
        validRows: validRows.length,
        invalidRows: rows.length - validRows.length,
        duplicateStrategy,
        status: BulkImportStatus.PROCESSING,
        successCount: 0,
        skippedCount: 0,
        replacedCount: 0,
        failedCount: 0,
      },
    });

    runId = run.id;

    let successCount = 0;
    let skippedCount = 0;
    let replacedCount = 0;
    let failedCount = 0;

    // Process each valid row
    for (const row of validRows) {
      try {
        await prisma.$transaction(async (tx) => {
          const { data, resolvedData } = row;

          if (!resolvedData) {
            throw new Error("Missing resolved data");
          }

          const {
            examId,
            examCode,
            examYear,
            subjectId,
            topicId,
            subTopicId,
            previousYearPaperId,
            difficulty,
            status,
            source,
            isDuplicate,
            duplicateQuestionId,
          } = resolvedData;

          let questionId: string | null = null;
          let questionCode: string | null = null;

          // Handle duplicates
          if (isDuplicate && duplicateQuestionId) {
            if (duplicateStrategy === BulkImportDuplicateStrategy.SKIP) {
              skippedCount++;

              await tx.bulkImportRow.create({
                data: {
                  runId: run.id,
                  rowNumber: row.rowNumber,
                  status: BulkImportRowStatus.SKIPPED,
                  questionId: duplicateQuestionId,
                  questionCode: (await tx.question.findUnique({ where: { id: duplicateQuestionId } }))?.code,
                  rawData: data as any,
                },
              });
              return;
            } else if (duplicateStrategy === BulkImportDuplicateStrategy.REPLACE) {
              // Update existing question
              const updated = await tx.question.update({
                where: { id: duplicateQuestionId },
                data: {
                  examId,
                  subjectId,
                  topicId,
                  subTopicId,
                  previousYearPaperId,
                  text: data.questionText,
                  imageUrl: data.image || null,
                  difficulty,
                  status,
                  source,
                  examYear,
                },
              });

              questionId = updated.id;
              questionCode = updated.code;

              // Replace options
              await tx.questionOption.deleteMany({ where: { questionId: updated.id } });
              await tx.questionOption.createMany({
                data: OPTION_LABELS.map((label, order) => ({
                  questionId: updated.id,
                  label,
                  text: data[`option${label}` as keyof typeof data] as string,
                  isCorrect: data.correctAnswer === label,
                  order,
                })),
              });

              replacedCount++;

              await tx.bulkImportRow.create({
                data: {
                  runId: run.id,
                  rowNumber: row.rowNumber,
                  status: BulkImportRowStatus.REPLACED,
                  questionId,
                  questionCode,
                  rawData: data as any,
                },
              });
              return;
            }
            // ADD_AS_NEW falls through to create a new question
          }

          // Create new question (for non-duplicates or ADD_AS_NEW strategy)
          if (!questionId) {
            const code = await allocateQuestionCode(tx, questionCodeScope(examCode, examYear));

            const created = await tx.question.create({
              data: {
                code,
                examId,
                subjectId,
                topicId,
                subTopicId,
                previousYearPaperId,
                text: data.questionText,
                imageUrl: data.image || null,
                difficulty,
                status,
                source,
                examYear,
              },
            });

            questionId = created.id;
            questionCode = created.code;

            await tx.questionOption.createMany({
              data: OPTION_LABELS.map((label, order) => ({
                questionId: created.id,
                label,
                text: data[`option${label}` as keyof typeof data] as string,
                isCorrect: data.correctAnswer === label,
                order,
              })),
            });

            successCount++;
          }

          // Record import row
          await tx.bulkImportRow.create({
            data: {
              runId: run.id,
              rowNumber: row.rowNumber,
              status: BulkImportRowStatus.SUCCESS,
              questionId,
              questionCode,
              rawData: data as any,
            },
          });
        });
      } catch (error) {
        failedCount++;

        // Record failed row
        await prisma.bulkImportRow.create({
          data: {
            runId: run.id,
            rowNumber: row.rowNumber,
            status: BulkImportRowStatus.FAILED,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
            rawData: row.data as any,
          },
        });
      }
    }

    // Record invalid rows
    for (const row of rows.filter((r) => !r.isValid)) {
      await prisma.bulkImportRow.create({
        data: {
          runId: run.id,
          rowNumber: row.rowNumber,
          status: BulkImportRowStatus.FAILED,
          errorMessage: row.errors.join(", "),
          rawData: row.data as any,
        },
      });
    }

    // Update run status
    const finalStatus =
      failedCount > 0 && successCount === 0
        ? BulkImportStatus.FAILED
        : failedCount > 0
          ? BulkImportStatus.PARTIALLY_COMPLETED
          : BulkImportStatus.COMPLETED;

    await prisma.bulkImportRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        successCount,
        skippedCount,
        replacedCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "BULK_IMPORT_COMPLETED",
        entityType: "BulkImportRun",
        entityId: run.id,
        metadata: { successCount, skippedCount, replacedCount, failedCount },
      },
    });

    return NextResponse.json({
      success: true,
      runId: run.id,
      total: rows.length,
      successCount,
      skippedCount,
      replacedCount,
      failedCount,
      status: finalStatus,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/import error:", error);

    // Update run status to failed if it was created
    if (runId) {
      await prisma.bulkImportRun.update({
        where: { id: runId },
        data: {
          status: BulkImportStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import questions" },
      { status: 500 }
    );
  }
}
