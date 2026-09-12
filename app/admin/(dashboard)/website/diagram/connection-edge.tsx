import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import type { ConnectionSource } from "@/lib/route-connections";
import styles from "./graph-view.module.css";

export type ConnectionEdgeType = Edge<
  { source: ConnectionSource; label?: string; broken: boolean; showLabel?: boolean },
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

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={styles.edge}
        data-broken={broken || undefined}
        style={broken ? { strokeDasharray: 5 } : undefined}
      />
      {data && data.showLabel !== false ? (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            data-broken={broken || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {broken ? "⚠ " : ""}
            {data.label ?? data.source}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
