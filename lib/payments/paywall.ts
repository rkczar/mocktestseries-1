import "server-only";
import { redirect } from "next/navigation";
import { PaymentRequiredError, paywallHref } from "@/lib/payments/access";

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
    if (e instanceof PaymentRequiredError) redirect(paywallHref(e.access));
    throw e;
  }
}
