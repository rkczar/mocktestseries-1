import { redirect } from "next/navigation";
import { PLANS_AND_PRICING_PATH } from "@/lib/plans-path";

/**
 * The student plans list moved to the public Plans & Pricing page, which
 * shows the same Admin products plus per-student Active / Already Enrolled
 * state. Kept as a redirect: paywall links (lib/payments/access.ts) and old
 * bookmarks still point here.
 */
export default function PlansPage() {
  redirect(PLANS_AND_PRICING_PATH);
}
