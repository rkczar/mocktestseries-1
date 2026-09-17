"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { startLiveTestAttempt } from "@/lib/test-attempt";

export async function startLiveTestFromListAction(liveTestId: string) {
  const student = await requireStudent();
  const attempt = await startLiveTestAttempt(student.id, liveTestId);
  redirect(`/student/attempt/${attempt.id}`);
}
