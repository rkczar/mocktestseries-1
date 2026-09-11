import type { DiagramNodeStatus } from "@/lib/diagram/types";

import { STATUS_META } from "./statusMeta";

const ORDER: DiagramNodeStatus[] = ["ACTIVE", "COMING_SOON", "DRAFT", "IN_DEVELOPMENT", "BROKEN", "DISCONNECTED", "NEEDS_REVIEW"];

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-border bg-surface px-4 py-3">
      <span className="text-[12px] font-bold text-text-faint uppercase tracking-wide">Legend</span>
      {ORDER.map((status) => {
        const meta = STATUS_META[status];
        const Icon = meta.icon;
        return (
          <span key={status} className={`inline-flex items-center gap-1.5 text-[12.5px] font-semibold ${meta.textClass}`}>
            <Icon className="size-3.5" strokeWidth={2.2} />
            {meta.label}
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-text-faint">
        <span className="inline-block h-0 w-4 border-t-[1.5px] border-dashed border-text-faint" />
        Planned / not yet built
      </span>
    </div>
  );
}
