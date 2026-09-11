import { NextResponse } from "next/server";
import { z } from "zod";

import { AIExplanationUnavailableError, getOrCreateAIExplanation } from "@/lib/ai/explainQuestion";
import { requireStudentSession, UnauthorizedError } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";

const bodySchema = z.object({ attemptId: z.string().min(1), questionId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const { student } = await requireStudentSession();
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const { attemptId, questionId } = parsed.data;

    // The AI walkthrough is study material for a question the student has already answered —
    // gate it on owning a *submitted* attempt that included that question, rather than trusting
    // the client, so it can't be used to fish for answers mid-test.
    const attempt = await prisma.testAttempt.findUnique({
      where: { id: attemptId },
      select: {
        studentId: true,
        submittedAt: true,
        test: { select: { questions: { where: { id: questionId }, select: { id: true } } } },
      },
    });
    if (!attempt || attempt.studentId !== student.id || !attempt.submittedAt) {
      return NextResponse.json({ error: "Attempt not found." }, { status: 404 });
    }
    if (attempt.test.questions.length === 0) {
      return NextResponse.json({ error: "Question not in this attempt." }, { status: 404 });
    }

    const explanation = await getOrCreateAIExplanation(questionId);
    return NextResponse.json({ explanation });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    if (error instanceof AIExplanationUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
