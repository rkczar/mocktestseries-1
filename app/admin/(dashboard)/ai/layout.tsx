import { AiEngineSubnav } from "@/components/admin/ai/engine-subnav";

/**
 * Admin → AI: one section switcher above every AI page (Overview, Providers,
 * Models, Features, Analytics, Budgets, History). Access is checked per page —
 * the existing Solutions / Variants / Usage / Settings pages keep their own rules.
 */
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <AiEngineSubnav />
      {children}
    </div>
  );
}
