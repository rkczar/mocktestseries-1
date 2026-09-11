import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";

import { updatePricingPlanAction } from "../../actions";
import { PricingPlanForm } from "../../PricingPlanForm";

export const metadata: Metadata = { title: "Edit Pricing Plan · Admin" };

export default async function EditPricingPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await prisma.pricingPlan.findUnique({ where: { id } });
  if (!plan) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit pricing plan</h1>
      <div className="mt-6">
        <PricingPlanForm plan={plan} action={updatePricingPlanAction} submitLabel="Save changes" />
      </div>
    </div>
  );
}
