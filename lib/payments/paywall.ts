import "server-only";
import { redirect, unstable_rethrow } from "next/navigation";
import { PaymentRequiredError, paywallHref } from "@/lib/payments/access";
import { PlatformPausedError } from "@/lib/platform-controls";
import { TestEngineError } from "@/lib/test-engine-log";
import { testRefusalKey } from "@/lib/test-refusals";

/**
 * Wraps a test-start call so a PaymentRequiredError sends the student to the
 * right checkout/plans page instead of an error screen. redirect() is thrown
 * from the catch on purpose (it is the control-flow exception); any other
 * error is re-thrown unchanged.
 */
export async function startOrPaywall<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (e) {
    if (e instanceof PaymentRequiredError) redirect(paywallHref(e.access, e.content));
    // Platform Controls paused new test starts: explain instead of an error screen.
    if (e instanceof PlatformPausedError) redirect(`/student/unavailable?feature=${e.control}`);
    throw e;
  }
}

/**
 * startOrPaywall() for starts with no inline error surface — a plain link
 * (/student/attempt/resume from the public exam pages) or a bare
 * `<form action>` button. A refusal the student can't fix by retrying (not
 * released yet, window closed, no questions, retake blocked, removed) lands
 * on /student/unavailable with a fixed explanation instead of the
 * "This page couldn't load" crash screen. Unknown errors still throw.
 */
export async function startOrExplain<T>(
  start: () => Promise<T>,
  context: { route: string; studentId: string; contentId: string }
): Promise<T> {
  try {
    return await startOrPaywall(start);
  } catch (e) {
    unstable_rethrow(e); // paywall / pause redirects propagate
    if (e instanceof TestEngineError) {
      const reason = testRefusalKey(e.message);
      console.warn(`[test-start] ${JSON.stringify({ ...context, code: e.code, reason })}`);
      redirect(`/student/unavailable?test=${reason}`);
    }
    throw e;
  }
}
