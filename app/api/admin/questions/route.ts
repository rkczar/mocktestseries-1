import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import type { QuestionStatus, QuestionDifficulty, QuestionSource } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

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
    const isPyq = searchParams.get("isPyq") === "true" ? true : undefined;
    const search = searchParams.get("search") || undefined;

    // Build where clause
    const where: any = {};

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

    // Text search across question text and code
    if (search) {
      where.OR = [
        { text: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
      ];
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
          options: {
            orderBy: { order: "asc" },
            select: { id: true, label: true, text: true, isCorrect: true },
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

export async function DELETE(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const { searchParams } = new URL(request.url);
    const ids = searchParams.get("ids")?.split(",").filter(Boolean);

    if (!ids || ids.length === 0) {
      return NextResponse.json({ error: "No question IDs provided" }, { status: 400 });
    }

    // Check if any questions are in use (in mock tests or custom modules)
    const questionsInUse = await prisma.question.findMany({
      where: {
        id: { in: ids },
        OR: [
          { mockTestQuestions: { some: {} } },
          { customModuleQuestions: { some: {} } },
        ],
      },
      select: { id: true, code: true },
    });

    if (questionsInUse.length > 0) {
      return NextResponse.json(
        {
          error: "Cannot delete questions that are in use",
          questionsInUse: questionsInUse.map((q) => q.code),
        },
        { status: 400 }
      );
    }

    // Delete questions
    const result = await prisma.question.deleteMany({
      where: { id: { in: ids } },
    });

    return NextResponse.json({
      success: true,
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("DELETE /api/admin/questions error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete questions" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    const { ids, status } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No question IDs provided" }, { status: 400 });
    }

    if (!status || !["DRAFT", "PUBLISHED", "ARCHIVED"].includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const result = await prisma.question.updateMany({
      where: { id: { in: ids } },
      data: { status },
    });

    return NextResponse.json({
      success: true,
      updatedCount: result.count,
    });
  } catch (error) {
    console.error("PATCH /api/admin/questions error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update questions" },
      { status: 500 }
    );
  }
}
