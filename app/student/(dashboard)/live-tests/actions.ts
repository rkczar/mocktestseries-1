"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { startLiveTestAttempt } from "@/lib/test-attempt";

export async function startLiveTestFromListAction(liveTestId: string) {
  const student = await requireStudent();
  const attempt = await startOrPaywall(() => startLiveTestAttempt(student.id, liveTestId));
  redirect(`/student/attempt/${attempt.id}`);
}
