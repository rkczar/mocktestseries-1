"use client";

import { useMemo } from "react";
import type { DiagramNode } from "@/lib/diagram-graph";
import { resolveDisplayStatus, summaryBucket, type SummaryBucket } from "@/lib/diagram-status";
import styles from "./graph-view.module.css";

type CardBucket = SummaryBucket | "ALL";

const CARD_ORDER: { bucket: CardBucket; label: string }[] = [
  { bucket: "ALL", label: "Total Pages" },
  { bucket: "LIVE", label: "Live" },
  { bucket: "DRAFT", label: "Draft" },
  { bucket: "BROKEN", label: "Broken" },
  { bucket: "DISCONNECTED", label: "Disconnected" },
  { bucket: "DEPRECATED", label: "Deprecated" },
];

/** Top overview cards (Section 9). Clicking a card filters the diagram to that bucket; clicking the active one clears the filter. */
export function SummaryCards({
  nodes,
  active,
  onSelect,
}: {
  nodes: DiagramNode[];
  active: CardBucket;
  onSelect: (bucket: CardBucket) => void;
}) {
  const counts = useMemo(() => {
    const acc: Record<CardBucket, number> = { ALL: nodes.length, LIVE: 0, DRAFT: 0, BROKEN: 0, DISCONNECTED: 0, DEPRECATED: 0 };
    for (const node of nodes) {
      const bucket = summaryBucket(resolveDisplayStatus(node).key);
      acc[bucket] += 1;
    }
    return acc;
  }, [nodes]);

  return (
    <div className={styles.summaryRow} role="group" aria-label="Route status summary">
      {CARD_ORDER.map(({ bucket, label }) => (
        <button
          key={bucket}
          type="button"
          className={styles.summaryCard}
          data-bucket={bucket}
          data-active={active === bucket || undefined}
          onClick={() => onSelect(active === bucket ? "ALL" : bucket)}
        >
          <span className={styles.summaryCount}>{counts[bucket]}</span>
          <span className={styles.summaryLabel}>{label}</span>
        </button>
      ))}
    </div>
  );
}

export type { CardBucket };
