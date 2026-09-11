import { AlertTriangle, CheckCircle2, HelpCircle, Sparkles, Unplug, Wrench } from "lucide-react";

import type { DiagramNodeStatus } from "@/lib/diagram/types";

export const STATUS_META: Record<
  DiagramNodeStatus,
  { label: string; icon: typeof CheckCircle2; textClass: string; tintClass: string; borderClass: string }
> = {
  ACTIVE: {
    label: "Active",
    icon: CheckCircle2,
    textClass: "text-success-text",
    tintClass: "bg-success-tint",
    borderClass: "border-success-border",
  },
  COMING_SOON: {
    label: "Coming Soon",
    icon: Sparkles,
    textClass: "text-brand-accent-text",
    tintClass: "bg-brand-accent-tint",
    borderClass: "border-brand-accent-border",
  },
  DRAFT: {
    label: "Draft",
    icon: Wrench,
    textClass: "text-text-muted",
    tintClass: "bg-accent",
    borderClass: "border-border-strong",
  },
  IN_DEVELOPMENT: {
    label: "In Development",
    icon: Wrench,
    textClass: "text-brand-accent-text",
    tintClass: "bg-brand-accent-tint",
    borderClass: "border-brand-accent-border",
  },
  BROKEN: {
    label: "Broken",
    icon: AlertTriangle,
    textClass: "text-error",
    tintClass: "bg-error-tint",
    borderClass: "border-error-border",
  },
  DISCONNECTED: {
    label: "Disconnected",
    icon: Unplug,
    textClass: "text-error",
    tintClass: "bg-error-tint",
    borderClass: "border-error-border",
  },
  NEEDS_REVIEW: {
    label: "Needs Review",
    icon: HelpCircle,
    textClass: "text-text-muted",
    tintClass: "bg-accent",
    borderClass: "border-border-strong",
  },
};

export function StatusBadge({ status, className = "" }: { status: DiagramNodeStatus; className?: string }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-bold ${meta.tintClass} ${meta.borderClass} ${meta.textClass} ${className}`}
    >
      <Icon className="size-3.5" strokeWidth={2.2} />
      {meta.label}
    </span>
  );
}
