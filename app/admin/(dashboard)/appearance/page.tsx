import type { Metadata } from "next";

import { StatusBanner } from "@/components/admin/StatusBanner";
import { getAppearance } from "@/lib/appearance";

import { AppearanceForm } from "./AppearanceForm";

export const metadata: Metadata = { title: "Appearance · Admin" };

export default async function AppearancePage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { success, error } = await searchParams;
  const appearance = await getAppearance();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Appearance</h1>
      <p className="mt-1.5 max-w-lg text-sm text-text-muted">
        Frontend brand colors, fonts, and button radius. Changes apply immediately across the
        public site.
      </p>
      <StatusBanner success={success} error={error} />
      <div className="mt-6">
        <AppearanceForm appearance={appearance} />
      </div>
    </div>
  );
}
