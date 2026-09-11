import { CtaRow } from "./CtaRow";

const SLOTS = [
  { slot: "header_primary", label: "Header — primary button" },
  { slot: "hero_primary", label: "Hero — primary button" },
  { slot: "hero_secondary", label: "Hero — secondary button" },
  { slot: "final_primary", label: "Final CTA — primary button" },
  { slot: "final_secondary", label: "Final CTA — secondary button" },
];

export function CtaTab({
  ctaButtons,
}: {
  ctaButtons: Record<string, { label: string; href: string; variant: string; isActive: boolean }>;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {SLOTS.map((s) => (
        <CtaRow key={s.slot} slot={s.slot} label={s.label} cta={ctaButtons[s.slot] ?? null} />
      ))}
    </div>
  );
}
