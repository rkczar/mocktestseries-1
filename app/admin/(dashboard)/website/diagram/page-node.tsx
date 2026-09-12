import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import type { BadgeProps } from "@/components/ui/badge";
import type { DiagramNode } from "@/lib/diagram-graph";
import styles from "./graph-view.module.css";

const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  CONNECTED: "success",
  WARNING: "warning",
  BROKEN: "error",
  ORPHAN: "error",
  UNAUTHORIZED: "error",
  DRAFT: "neutral",
};

const USER_TYPE_COLOR: Record<string, string> = {
  PUBLIC: "var(--color-info)",
  STUDENT: "var(--color-success)",
  ADMIN: "var(--color-primary)",
};

export type PageNodeType = Node<{ node: DiagramNode }, "pageNode">;

export function PageNode({ data, selected }: NodeProps<PageNodeType>) {
  const { node } = data;
  const accent = USER_TYPE_COLOR[node.userType] ?? "var(--color-border)";

  return (
    <div
      className={styles.node}
      data-selected={selected || undefined}
      style={{ borderLeftColor: accent }}
    >
      <Handle type="target" position={Position.Top} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeName} title={node.pageName}>
          {node.pageName}
        </span>
        <Badge variant={STATUS_VARIANT[node.status]} className={styles.nodeBadge}>
          {node.status}
        </Badge>
      </div>
      <div className={styles.nodeRoute}>{node.route}</div>
      <div className={styles.nodeMeta}>
        <span style={{ color: accent }}>{node.userType}</span>
        <span>
          {node.connectionCount} connection{node.connectionCount === 1 ? "" : "s"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
    </div>
  );
}
