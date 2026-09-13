import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import type { BadgeProps } from "@/components/ui/badge";
import type { DiagramNode } from "@/lib/diagram-graph";
import styles from "./graph-view.module.css";

/** Presentational label layered on top of the stored `status` — computed live from the graph shape, not persisted. */
function displayStatus(node: DiagramNode): { label: string; variant: BadgeProps["variant"] } {
  if (node.status === "BROKEN" || node.status === "ORPHAN" || node.status === "UNAUTHORIZED") {
    return { label: node.status, variant: "error" };
  }
  if (node.status === "DRAFT") return { label: "DRAFT", variant: "neutral" };
  if (node.isolated) return { label: "ORPHAN", variant: "error" };
  if (node.noIncoming) return { label: "NO INCOMING", variant: "warning" };
  if (node.status === "WARNING") return { label: "WARNING", variant: "warning" };
  return { label: "CONNECTED", variant: "success" };
}

const USER_TYPE_COLOR: Record<string, string> = {
  PUBLIC: "var(--color-info)",
  STUDENT: "var(--color-success)",
  ADMIN: "var(--color-primary)",
};

export type PageNodeType = Node<{ node: DiagramNode; dimmed?: boolean }, "pageNode">;

export function PageNode({ data, selected }: NodeProps<PageNodeType>) {
  const { node, dimmed } = data;
  const accent = USER_TYPE_COLOR[node.userType] ?? "var(--color-border)";
  const status = displayStatus(node);

  return (
    <div
      className={styles.node}
      data-selected={selected || undefined}
      data-dimmed={dimmed || undefined}
      style={{ borderLeftColor: accent }}
    >
      <Handle type="target" position={Position.Top} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeName} title={node.pageName}>
          {node.pageName}
        </span>
        <Badge variant={status.variant} className={styles.nodeBadge}>
          {status.label}
        </Badge>
      </div>
      <div className={styles.nodeRoute}>{node.route}</div>
      <div className={styles.nodeMeta}>
        <span style={{ color: accent }}>{node.userType}</span>
        <span>
          IN: {node.incoming.length} · OUT: {node.outgoing.length}
        </span>
      </div>
      {node.autoDiscovered ? <div className={styles.nodeNewTag}>🆕 auto-discovered</div> : null}
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
    </div>
  );
}
