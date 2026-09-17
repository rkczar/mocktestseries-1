"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DiagramNode } from "@/lib/diagram-graph";
import { DIAGRAM_GROUPS, type DiagramGroupKey } from "@/lib/diagram-groups";
import { resolveDisplayStatus } from "@/lib/diagram-status";
import styles from "./graph-view.module.css";

function depthOf(route: string) {
  return route.split("/").filter(Boolean).length;
}

/**
 * Section 10 — on narrow screens the pan/zoom graph canvas isn't readable at
 * any useful text size, so below the `md` breakpoint the diagram switches to
 * this plain, always-vertical, collapsible tree instead of shrinking node
 * text. Same node data, same click-through to the details drawer.
 */
export function MobileTreeView({
  groupedNodes,
  onSelect,
}: {
  groupedNodes: Map<DiagramGroupKey, DiagramNode[]>;
  onSelect: (node: DiagramNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<DiagramGroupKey>>(new Set());

  const toggle = (key: DiagramGroupKey) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const visibleGroups = DIAGRAM_GROUPS.filter((g) => (groupedNodes.get(g.key)?.length ?? 0) > 0);

  return (
    <div className={styles.mobileTree}>
      {visibleGroups.map((group) => {
        const nodes = [...(groupedNodes.get(group.key) ?? [])].sort((a, b) => a.route.localeCompare(b.route));
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key} className={styles.mobileGroup}>
            <button type="button" className={styles.mobileGroupHeader} onClick={() => toggle(group.key)}>
              {isCollapsed ? <ChevronRight className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />}
              <span className={styles.mobileGroupLabel}>{group.label}</span>
              <span className={styles.mobileGroupCount}>{nodes.length}</span>
            </button>
            {!isCollapsed ? (
              <div className={styles.mobileGroupBody}>
                {nodes.map((node) => {
                  const status = resolveDisplayStatus(node);
                  return (
                    <button
                      key={node.id}
                      type="button"
                      className={styles.mobileNode}
                      style={{ paddingLeft: `${12 + Math.max(0, depthOf(node.route) - 1) * 14}px` }}
                      onClick={() => onSelect(node)}
                    >
                      <span className={styles.mobileNodeText}>
                        <span className={styles.mobileNodeName}>{node.pageName}</span>
                        <span className={styles.mobileNodeRoute}>{node.route}</span>
                      </span>
                      <Badge variant={status.variant} className={styles.nodeBadge}>
                        {status.label}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
