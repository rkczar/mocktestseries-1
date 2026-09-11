import { AlertTriangle, CheckCircle2, FileText, HelpCircle, Sparkles, Unplug, Wrench } from "lucide-react";

import type { DiagramSummary } from "@/lib/diagram/types";

export function SummaryCards({ summary }: { summary: DiagramSummary }) {
  const cards = [
    { label: "Total Pages", value: summary.totalPages, icon: FileText, tone: "text-primary" },
    { label: "Active Pages", value: summary.activePages, icon: CheckCircle2, tone: "text-success-text" },
    { label: "Coming Soon", value: summary.comingSoon, icon: Sparkles, tone: "text-brand-accent-text" },
    { label: "Draft / In Dev", value: summary.draftOrInDevelopment, icon: Wrench, tone: "text-text-muted" },
    { label: "Broken Links", value: summary.brokenLinks, icon: AlertTriangle, tone: "text-error" },
    { label: "Disconnected", value: summary.disconnectedPages, icon: Unplug, tone: "text-error" },
    { label: "Needs Review", value: summary.needsReview, icon: HelpCircle, tone: "text-text-muted" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {cards.map((card) => (
        <div key={card.label} className="rounded-[12px] border border-border bg-surface p-3.5">
          <card.icon className={`size-4.5 ${card.tone}`} strokeWidth={1.9} />
          <p className="mt-2 font-display text-xl font-bold text-text-heading">{card.value}</p>
          <p className="mt-0.5 text-[12px] text-text-faint">{card.label}</p>
        </div>
      ))}
    </div>
  );
}
