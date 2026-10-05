import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { QuestionMediaError, setQuestionRichFields } from "@/lib/question-media-admin";

/**
 * PATCH json { contentFormat?: "PLAIN" | "RICH_V1", explanation?: string | null }
 * Admin only (QUESTIONS_MANAGE). The format can only change on a DRAFT question.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new QuestionMediaError("JSON body required.");
    const question = await setQuestionRichFields({ questionId: id, actorId: session.user.id ?? null, contentFormat: body.contentFormat, explanation: body.explanation });
    return NextResponse.json({ question });
  } catch (error) {
    if (error instanceof QuestionMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("PATCH /api/admin/questions/[id]/rich error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
