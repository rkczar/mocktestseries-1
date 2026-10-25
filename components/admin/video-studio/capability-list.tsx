import { CheckCircle2, CircleDashed, Clock, XCircle } from "lucide-react";
import type { CapabilityCheck } from "@/lib/video-studio/types";

const ICON = {
  ready: { Icon: CheckCircle2, cls: "text-[var(--color-success)]", label: "Ready" },
  missing: { Icon: XCircle, cls: "text-[var(--color-error)]", label: "Not configured" },
  pending_approval: { Icon: Clock, cls: "text-[var(--color-warning)]", label: "Awaiting approval" },
  not_built: { Icon: CircleDashed, cls: "text-[var(--color-muted-foreground)]", label: "Later phase" },
} as const;

export function CapabilityList({ items }: { items: CapabilityCheck[] }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="capabilities">
      {items.map((c) => {
        const s = ICON[c.status];
        return (
          <li key={c.key} className="flex gap-3" data-capability={c.key} data-state={c.status}>
            <s.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.cls}`} aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="font-medium">
                {c.label} <span className={`text-xs font-normal ${s.cls}`}>· {s.label}</span>
              </p>
              {c.provider ? <p className="text-xs text-[var(--color-foreground)]">{c.provider}</p> : null}
              <p className="text-xs text-[var(--color-muted-foreground)]">{c.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
