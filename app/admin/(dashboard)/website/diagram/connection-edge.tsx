import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { ConnectionSource } from "@/lib/route-connections";
import styles from "./graph-view.module.css";

export type ConnectionEdgeType = Edge<
  { source: ConnectionSource; label?: string; broken: boolean; showLabel?: boolean; dimmed?: boolean },
  "connectionEdge"
>;

export function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<ConnectionEdgeType>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  const broken = data?.broken ?? false;
  const dimmed = data?.dimmed ?? false;
  // Admin -> frontend config/data edges (Section 6) get their own visual
  // treatment so they read as "this configures that", not "clicking here
  // takes you there".
  const isAdminConfig = data?.source === "admin-config" && !broken;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={styles.edge}
        data-broken={broken || undefined}
        data-dimmed={dimmed || undefined}
        data-admin-config={isAdminConfig || undefined}
        style={broken || isAdminConfig ? { strokeDasharray: broken ? 5 : "2 6" } : undefined}
      />
      {data && data.showLabel !== false ? (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            data-broken={broken || undefined}
            data-dimmed={dimmed || undefined}
            data-admin-config={isAdminConfig || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {broken ? "⚠ " : isAdminConfig ? "⚙ " : ""}
            {data.label ?? data.source}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
