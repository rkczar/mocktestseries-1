import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import type { Prisma, QuestionStatus, QuestionDifficulty, QuestionSource } from "@prisma/client";

const MAX_IDS_ONLY = 5000;

export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const { searchParams } = new URL(request.url);

    // Pagination
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);
    const skip = (page - 1) * limit;

    // Filters
    const examId = searchParams.get("examId") || undefined;
    const examYear = searchParams.get("examYear") ? parseInt(searchParams.get("examYear")!, 10) : undefined;
    const subjectId = searchParams.get("subjectId") || undefined;
    const topicId = searchParams.get("topicId") || undefined;
    const subTopicId = searchParams.get("subTopicId") || undefined;
    const source = searchParams.get("source") as QuestionSource | undefined;
    const difficulty = searchParams.get("difficulty") as QuestionDifficulty | undefined;
    const status = searchParams.get("status") as QuestionStatus | undefined;
    const isPyq = searchParams.get("isPyq") === "true" ? true : searchParams.get("isPyq") === "false" ? false : undefined;
    const search = searchParams.get("search") || undefined;
    const hasImage = searchParams.get("hasImage") || undefined; // "true" | "false"
    const reviewRequiredParam = searchParams.get("reviewRequired") || undefined; // "true" | "false"
    const importBatchId = searchParams.get("importBatchId") || undefined;
    const importedFrom = searchParams.get("importedFrom") || undefined; // ISO date, filters Question.createdAt
    const importedTo = searchParams.get("importedTo") || undefined;
    const idsOnly = searchParams.get("idsOnly") === "true";

    // Build where clause
    const where: Prisma.QuestionWhereInput = {};
    const and: Prisma.QuestionWhereInput[] = [];

    if (examId) where.examId = examId;
    if (examYear) where.examYear = examYear;
    if (subjectId) where.subjectId = subjectId;
    if (topicId) where.topicId = topicId;
    if (subTopicId) where.subTopicId = subTopicId;
    if (source) where.source = source;
    if (difficulty) where.difficulty = difficulty;
    if (status) where.status = status;
    if (isPyq !== undefined) {
      where.previousYearPaperId = isPyq ? { not: null } : null;
    }
    if (reviewRequiredParam !== undefined) {
      where.reviewRequired = reviewRequiredParam === "true";
    }
    if (importBatchId) where.importBatchId = importBatchId;
    if (importedFrom || importedTo) {
      where.createdAt = {
        ...(importedFrom ? { gte: new Date(importedFrom) } : {}),
        ...(importedTo ? { lte: new Date(importedTo) } : {}),
      };
    }

    // Text search: substring match on question text, plus a precise
    // (exact-or-prefix) match on the structured question code — a code like
    // "NEET-2024-Q001" shouldn't be fuzzily substring-matched the way free
    // text is.
    if (search) {
      and.push({
        OR: [
          { text: { contains: search, mode: "insensitive" } },
          { code: { equals: search, mode: "insensitive" } },
          { code: { startsWith: search, mode: "insensitive" } },
        ],
      });
    }

    // Has Image: the question's own image, or any of its options'.
    if (hasImage === "true") {
      and.push({ OR: [{ imageUrl: { not: null } }, { options: { some: { imageUrl: { not: null } } } }] });
    } else if (hasImage === "false") {
      and.push({ imageUrl: null, options: { none: { imageUrl: { not: null } } } });
    }

    if (and.length > 0) where.AND = and;

    if (idsOnly) {
      const rows = await prisma.question.findMany({
        where,
        select: { id: true },
        take: MAX_IDS_ONLY,
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json({ ids: rows.map((r) => r.id), truncated: rows.length >= MAX_IDS_ONLY });
    }

    // Execute queries in parallel
    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          exam: { select: { id: true, name: true, code: true } },
          subject: { select: { id: true, name: true } },
          topic: { select: { id: true, name: true } },
          subTopic: { select: { id: true, name: true } },
          previousYearPaper: { select: { id: true, year: true, title: true } },
          importBatch: { select: { id: true, label: true, filename: true, createdAt: true } },
          options: {
            orderBy: { order: "asc" },
            select: { id: true, label: true, text: true, imageUrl: true, isCorrect: true },
          },
        },
      }),
      prisma.question.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      questions,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    console.error("GET /api/admin/questions error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch questions" },
      { status: 500 }
    );
  }
}

// Bulk status changes, review-flagging, and delete/archive all live in
// app/api/admin/questions/bulk-actions/route.ts, which adds the fuller
// reference check (mock/custom/grand/live test usage, saved bookmarks,
// reports) before ever hard-deleting a question. This route now only reads.
