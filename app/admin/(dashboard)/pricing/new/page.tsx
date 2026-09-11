import type { Metadata } from "next";

import { createPricingPlanAction } from "../actions";
import { PricingPlanForm } from "../PricingPlanForm";

export const metadata: Metadata = { title: "New Pricing Plan · Admin" };

export default function NewPricingPlanPage() {
  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New pricing plan</h1>
      <div className="mt-6">
        <PricingPlanForm action={createPricingPlanAction} submitLabel="Create plan" />
      </div>
    </div>
  );
}
