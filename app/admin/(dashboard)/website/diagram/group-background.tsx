import { ChevronDown, ChevronRight } from "lucide-react";
import type { NodeProps, Node } from "@xyflow/react";
import type { DiagramGroupKey } from "@/lib/diagram-groups";
import styles from "./graph-view.module.css";

export type GroupBackgroundType = Node<
  {
    label: string;
    groupKey: DiagramGroupKey;
    collapsed: boolean;
    counts: { live: number; draft: number; broken: number; disconnected: number; deprecated: number; total: number };
    onToggle: (key: DiagramGroupKey) => void;
  },
  "groupBackground"
>;

/** A non-interactive background container rendered behind a group's page nodes, with a sticky header showing the group name and a live status breakdown. Clicking the header collapses/expands just this one group. */
export function GroupBackground({ data }: NodeProps<GroupBackgroundType>) {
  const { label, groupKey, collapsed, counts, onToggle } = data;
  return (
    <div className={styles.groupBox} data-collapsed={collapsed || undefined}>
      <button type="button" className={styles.groupHeader} onClick={() => onToggle(groupKey)}>
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupCounts}>
          <span className={styles.groupCountTotal}>{counts.total}</span>
          {counts.broken > 0 ? <span className={styles.groupCountBroken}>{counts.broken} broken</span> : null}
          {counts.disconnected > 0 ? <span className={styles.groupCountDisconnected}>{counts.disconnected} disconnected</span> : null}
        </span>
      </button>
    </div>
  );
}
